// P4: hands-free speech -> signs for the guest screen. Nobody presses anything: the receptionist just talks.
// Whisper mode: VoiceListener cuts utterances, /api/transcribe, then /api/gloss per sentence.
// Browser mode (no OpenAI key, or Whisper unreachable): Chrome's continuous Web Speech recognition (CLAUDE.md rule 7).
// Sentences are handed over in the order they were spoken, even if a later one is transcribed first.
import { useCallback, useEffect, useRef, useState } from "react";
import { TranscribeError, toSignedSentences, transcribe, whisperAvailable, type SignedSentence } from "./speechToSigns";
import { VoiceListener } from "./voiceListener";

export type ListenState =
  | "starting"
  | "needs-click" // Chrome keeps audio suspended until the page gets a click or a key press
  | "listening"
  | "hearing" // someone is talking
  | "processing" // transcribing / glossing
  | "blocked"; // microphone denied or unavailable

export type ListenMode = "whisper" | "browser" | null;

// Whisper's usual inventions on noise (beeps, music, a door): always dropped, or only when short.
const NEVER_SAID = /^(you|bye|thanks for watching|thank you for watching|\.+)[.!]*$/i;
const SHORT_NOISE = /^(thank you|thanks|okay|ok)[.!]*$/i;

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
};

function browserRecognition(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const UNMUTE_GRACE_MS = 900; // speech still ending (or echoing) just after the mute is lifted
const MAX_MUTE_MS = 20000; // a mute is lifted on its own, even if "unmute" never arrives (page closed meanwhile)
const WHISPER_FAILURES_BEFORE_SWITCH = 3; // in a row; a missing key (401/503) switches at once
const RESTART_MS = [300, 1000, 3000]; // browser recognition restart backoff

/**
 * `muted`: while true (and shortly after), what the microphone hears is dropped. /guest sets it while /staff speaks
 * the guest's sentence aloud, so the avatar never signs our own voice back.
 */
export function useHandsFreeSpeech(onSentences: (sentences: SignedSentence[]) => void, muted = false) {
  const [state, setState] = useState<ListenState>("starting");
  const [mode, setMode] = useState<ListenMode>(null);
  const deliverRef = useRef(onSentences);
  useEffect(() => {
    deliverRef.current = onSentences;
  });
  const resumeRef = useRef<(() => void) | null>(null);
  const mutedUntil = useRef(0);
  useEffect(() => {
    mutedUntil.current = performance.now() + (muted ? MAX_MUTE_MS : UNMUTE_GRACE_MS);
  }, [muted]);
  const isMuted = () => performance.now() < mutedUntil.current;

  useEffect(() => {
    let active = true;
    let listener: VoiceListener | null = null;
    let recognition: Recognition | null = null;
    let order = Promise.resolve();
    let pending = 0;

    const idle = () => active && setState(pending > 0 ? "processing" : "listening");

    // Keeps spoken order: each job is awaited in turn before handing its sentences over.
    const enqueue = (job: Promise<SignedSentence[]>) => {
      pending++;
      setState("processing");
      order = order.then(async () => {
        const sentences = await job.catch((err) => {
          console.warn("[guest] speech not translated:", err);
          return [];
        });
        pending--;
        if (active && sentences.length > 0) deliverRef.current(sentences);
        idle();
      });
    };

    const startBrowser = () => {
      const Ctor = browserRecognition();
      if (!Ctor) {
        setState("blocked");
        return;
      }
      setMode("browser");
      console.info("[guest] listening with the browser's speech recognition");
      let clicked = false;
      let failedStarts = 0;
      const retry = () => {
        const wait = RESTART_MS[Math.min(failedStarts, RESTART_MS.length - 1)];
        failedStarts++;
        setTimeout(run, wait);
      };
      const run = () => {
        if (!active) return;
        const rec = new Ctor();
        rec.lang = "en-US";
        rec.continuous = true;
        rec.interimResults = true;
        rec.onresult = (event) => {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            const text = result[0].transcript.trim();
            if (isMuted()) continue;
            if (!result.isFinal) setState("hearing");
            else if (text) enqueue(toSignedSentences(text));
            else idle();
          }
        };
        rec.onerror = (event) => {
          if (event.error === "not-allowed" || event.error === "service-not-allowed") {
            active && setState(clicked ? "blocked" : "needs-click");
            recognition = null;
          }
        };
        rec.onend = () => {
          if (active && recognition === rec) retry(); // Chrome ends continuous sessions on its own
        };
        recognition = rec;
        try {
          rec.start();
          failedStarts = 0;
          idle();
        } catch (err) {
          console.warn("[guest] speech recognition did not start, retrying:", err);
          recognition = null;
          retry();
        }
      };
      resumeRef.current = () => {
        clicked = true;
        if (!recognition) run();
      };
      run();
    };

    const startWhisper = async () => {
      setMode("whisper");
      console.info("[guest] listening with Whisper");
      let startedMuted = false;
      let failures = 0;
      const l = new VoiceListener({
        onLost: () => {
          console.warn("[guest] microphone lost, restarting the listener");
          l.stop();
          if (listener === l) listener = null;
          if (active) setTimeout(() => active && void startWhisper(), 1000);
        },
        onSpeechStart: () => {
          startedMuted = isMuted();
          if (active && !startedMuted) setState("hearing");
        },
        onDiscard: idle,
        onUtterance: (wav, seconds) =>
          startedMuted || isMuted()
            ? idle()
            : enqueue(
            transcribe(wav, "speech.wav").then(
              (text) => {
                failures = 0;
                return !/[a-z]/i.test(text) || NEVER_SAID.test(text) || (seconds < 1.5 && SHORT_NOISE.test(text))
                  ? []
                  : toSignedSentences(text);
              },
              (err) => {
                failures++;
                const noKey = err instanceof TranscribeError && (err.status === 401 || err.status === 503);
                console.warn(`[guest] Whisper failed (${failures} in a row):`, err);
                // Missing key, or Whisper keeps failing: the browser's recognition takes over for what follows.
                if ((noKey || failures >= WHISPER_FAILURES_BEFORE_SWITCH) && listener === l) {
                  l.stop();
                  listener = null;
                  if (active) startBrowser();
                }
                return [];
              },
            ),
          ),
      });
      try {
        await l.start();
      } catch (err) {
        console.warn("[guest] microphone unavailable:", err);
        l.stop();
        if (active) setState("blocked");
        return;
      }
      if (!active) {
        l.stop();
        return;
      }
      listener = l;
      resumeRef.current = () => void l.resume()?.then(() => active && l.running && idle());
      if (l.running) idle();
      else setState("needs-click");
    };

    void whisperAvailable().then((ok) => {
      if (!active) return;
      if (ok) void startWhisper();
      else startBrowser();
    });

    return () => {
      active = false;
      listener?.stop();
      const rec = recognition;
      recognition = null;
      rec?.stop();
      resumeRef.current = null;
    };
  }, []);

  /** Call from a click or key press when state is "needs-click". */
  const resume = useCallback(() => resumeRef.current?.(), []);

  return { state, mode, resume };
}
