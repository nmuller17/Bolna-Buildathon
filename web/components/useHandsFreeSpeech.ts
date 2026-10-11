// P4: hands-free speech -> signs for the guest screen. Nobody presses anything: the receptionist just talks.
// Whisper mode: VoiceListener cuts utterances, /api/transcribe, then /api/gloss per sentence.
// Browser mode (no OpenAI key, or Whisper unreachable): Chrome's continuous Web Speech recognition (CLAUDE.md rule 7).
// Sentences are handed over in the order they were spoken, even if a later one is transcribed first.
import { useCallback, useEffect, useRef, useState } from "react";
import { toSignedSentences, transcribe, whisperAvailable, type SignedSentence } from "./speechToSigns";
import { VoiceListener } from "./voiceListener";

export type ListenState =
  | "starting"
  | "needs-click" // Chrome keeps audio suspended until the page gets a click or a key press
  | "listening"
  | "hearing" // someone is talking
  | "processing" // transcribing / glossing
  | "blocked"; // microphone denied or unavailable

export type ListenMode = "whisper" | "browser" | null;

// Whisper's usual inventions on short noises.
const HALLUCINATIONS = /^(thank you|thanks for watching|thank you for watching|you|bye|okay|\.+)[.!]*$/i;

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

export function useHandsFreeSpeech(onSentences: (sentences: SignedSentence[]) => void) {
  const [state, setState] = useState<ListenState>("starting");
  const [mode, setMode] = useState<ListenMode>(null);
  const deliverRef = useRef(onSentences);
  useEffect(() => {
    deliverRef.current = onSentences;
  });
  const resumeRef = useRef<(() => void) | null>(null);

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
      let clicked = false;
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
          if (active && recognition === rec) setTimeout(run, 250); // Chrome ends continuous sessions on its own
        };
        recognition = rec;
        try {
          rec.start();
          idle();
        } catch {
          setState("needs-click");
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
      const l = new VoiceListener({
        onSpeechStart: () => active && setState("hearing"),
        onDiscard: idle,
        onUtterance: (wav, seconds) =>
          enqueue(
            transcribe(wav, "speech.wav").then(
              (text) => (!/[a-z]/i.test(text) || (seconds < 1 && HALLUCINATIONS.test(text)) ? [] : toSignedSentences(text)),
              (err) => {
                // Whisper unreachable or failing: switch to the browser's recognition for what follows.
                console.warn("[guest] Whisper failed, switching to browser speech recognition:", err);
                l.stop();
                listener = null;
                if (active) startBrowser();
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
