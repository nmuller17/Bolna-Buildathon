"use client";
// SignBridge: the single screen, facing the Deaf guest. The receptionist has no screen: they talk, and they hear
// the guest's answers out loud.
//
// Front desk turn: the receptionist holds Space while talking (push-to-talk: a noisy room is never transcribed;
// ?handsfree=1 listens all the time instead). Each sentence is transcribed (/api/transcribe), glossed
// (/api/gloss, which also returns the receptionist's intents) and signed by the bellhop with karaoke captions.
// Guest turn: once the bellhop has finished (and the room is quiet for GUEST_TURN_DELAY_MS), the page asks the
// recognizer for the guest's turn (POST /turn on recognition/live_key.py) with the answers that make sense after
// the question (lib/voice/expectedAnswers.ts; one scripted answer per step with ?script=1). The camera frame turns
// green, the guest signs a whole sentence and rests their hands; the recognizer posts the sentence
// (/api/guest/signs -> /api/guest/stream) and this page speaks it (/api/tts, browser voice as fallback).
// Then back to the front desk. The microphone is muted for the whole guest turn and while the answer is spoken.
// Turn-taking lives in lib/turns.ts (pure, tested); this page only runs its side effects.
import { useCallback, useEffect, useRef, useState } from "react";
import AvatarCaptions from "@/components/AvatarCaptions";
import GuestCameraSlot, { RECOGNIZER_URL, type CameraState } from "@/components/GuestCameraSlot";
import GuestTurnBanner from "@/components/GuestTurnBanner";
import { speakText, warmUpVoice } from "@/components/speakSigns";
import { toSignedSentences, transcribe, type SignedSentence } from "@/components/speechToSigns";
import { usePushToTalk, type Recording } from "@/components/usePushToTalk";
import { useGuestEvents, type GuestTurnEvent, type GuestUtterance } from "@/components/useGuestEvents";
import { useHandsFreeSpeech } from "@/components/useHandsFreeSpeech";
import { mountAvatar, playGloss } from "@/lib/avatar/player";
import { guestTurnDue, initialTurns, nextExpected, turnsReducer, type TurnEvent, type TurnState } from "@/lib/turns";
import { DEMO_SCRIPT } from "@/lib/voice/expectedAnswers";
import type { StaffIntentId } from "@/lib/voice/intents";
import styles from "./page.module.css";

const SIGN_TIMEOUT_MS_PER_TOKEN = 4000; // longest a sign (or a fingerspelled word) may take before we move on
const TICK_MS = 150;
const TURN_REQUEST_TIMEOUT_MS = 2000;

export default function SignBridgePage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [webgl, setWebgl] = useState(true);
  const [caption, setCaption] = useState<SignedSentence>({ text: "", gloss: [] });
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [scriptMode, setScriptMode] = useState(false);
  const [started, setStarted] = useState(false); // the Start button was pressed (audio unlocked)
  const [handsFree, setHandsFree] = useState(false); // ?handsfree=1: listen all the time instead of push-to-talk
  const [talk, setTalk] = useState<"idle" | "recording" | "processing" | "blocked">("idle"); // push-to-talk
  const queue = useRef<SignedSentence[]>([]);
  const draining = useRef(false);
  const mounted = useRef(false);

  // Turn state: kept in a ref so the timers and callbacks always see the latest one, mirrored in React state.
  const turnsRef = useRef<TurnState>(initialTurns(0));
  const [turns, setTurns] = useState<TurnState>(turnsRef.current);
  const apply = useCallback((event: TurnEvent) => {
    const next = turnsReducer(turnsRef.current, event);
    if (next !== turnsRef.current) {
      turnsRef.current = next;
      setTurns(next);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setScriptMode(params.get("script") === "1");
    setHandsFree(params.get("handsfree") === "1");
  }, []);

  useEffect(() => {
    mounted.current = true;
    const mount = mountAvatar(stageRef.current!, { style: "bellhop" });
    setWebgl(mount.webgl);
    void warmUpVoice(); // /api/tts compiled and ElevenLabs connected before the first answer
    return () => {
      mounted.current = false;
      mount.unmount();
    };
  }, []);

  // Plays queued receptionist sentences in order. When the queue is empty, the bellhop has finished: the turn
  // machine learns the intents of the last sentence signed.
  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    let intents: StaffIntentId[] = [];
    while (queue.current.length > 0 && mounted.current) {
      const sentence = queue.current.shift()!;
      setCaption(sentence);
      setActiveIndex(null);
      setPlaying(true);
      try {
        // A sentence that fails or hangs (sign file missing, tab hidden) never blocks the ones after it.
        await Promise.race([
          playGloss(sentence.gloss, { onToken: (i) => mounted.current && setActiveIndex(i) }),
          new Promise((resolve) => setTimeout(resolve, SIGN_TIMEOUT_MS_PER_TOKEN * sentence.gloss.length + 6000)),
        ]);
      } catch (err) {
        console.warn(`[signbridge] could not sign "${sentence.text}":`, err);
      }
      setActiveIndex(null);
      intents = sentence.intents ?? [];
    }
    setPlaying(false);
    draining.current = false;
    apply({ type: "staffSigned", intents, now: performance.now() });
  }, [apply]);

  // What the microphone heard: signed only during the front desk turn (a transcription that lands after the
  // guest's turn started is dropped).
  const signHeard = useCallback(
    (sentences: SignedSentence[]) => {
      if (turnsRef.current.phase !== "frontDesk" || sentences.length === 0) return;
      queue.current.push(...sentences);
      void drain();
    },
    [drain],
  );
  const speech = useHandsFreeSpeech(signHeard, turns.phase !== "frontDesk", handsFree);

  // Push-to-talk: Space held = the receptionist is talking. Only during the front desk turn.
  const ptt = usePushToTalk();
  const holding = useRef(false);
  const starting = useRef<Promise<void>>(Promise.resolve());
  const pressStart = useCallback(() => {
    if (holding.current || turnsRef.current.phase !== "frontDesk") return;
    holding.current = true;
    setTalk("recording");
    starting.current = ptt.start().catch(() => {
      holding.current = false;
      setTalk("blocked");
    });
  }, [ptt]);
  const pressEnd = useCallback(async () => {
    if (!holding.current) return;
    holding.current = false;
    setTalk("processing");
    try {
      await starting.current; // a very quick release can land before the microphone has started
      const recording = await ptt.stop();
      const text = recording ? await transcribeRecording(recording) : "";
      if (text) signHeard(await toSignedSentences(text));
    } catch (err) {
      console.warn("[signbridge] push-to-talk failed:", err);
    } finally {
      setTalk((t) => (t === "blocked" ? t : "idle"));
    }
  }, [ptt, signHeard]);
  useEffect(() => {
    if (handsFree || !started) return;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      if (!e.repeat) pressStart();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      void pressEnd();
    };
    const blur = () => void pressEnd(); // released outside the window
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [handsFree, started, pressStart, pressEnd]);

  // The guest's answer: speak it, then back to the front desk. Guesses and mock answers are never spoken.
  const onUtterance = useCallback(
    (u: GuestUtterance) => {
      if (u.needsRepeat || u.mock || !u.text) return;
      apply({ type: "utterance", text: u.text, now: performance.now() });
      if (turnsRef.current.phase !== "speaking") return;
      void speakText(u.text).finally(() => apply({ type: "spoken", now: performance.now() }));
    },
    [apply],
  );
  const onTurnEnd = useCallback(
    (end: GuestTurnEvent) => apply({ type: "turnEnd", empty: end.empty, now: performance.now() }),
    [apply],
  );
  const guest = useGuestEvents(onUtterance, onTurnEnd);
  useEffect(() => {
    if (guest.turn && !(guest.turn as { replay?: boolean }).replay) apply({ type: "turnStart", now: performance.now() });
  }, [guest.turn, apply]);

  // Front desk activity: the bellhop signing, or the mic hearing / translating someone (read by the clock).
  const busy = useRef(false);
  busy.current =
    playing || draining.current || talk === "recording" || talk === "processing" ||
    speech.state === "hearing" || speech.state === "processing";

  // Clock: timeouts, and the start of the guest's turn once the front desk is done.
  const script = useRef(scriptMode);
  script.current = scriptMode;
  useEffect(() => {
    const timer = setInterval(() => {
      const now = performance.now();
      apply({ type: "tick", now, busy: busy.current || draining.current });
      if (!guestTurnDue(turnsRef.current, now)) return;
      const next = nextExpected(turnsRef.current, script.current);
      apply({ type: "requested", ...next, now });
      fetch(`${RECOGNIZER_URL}/turn`, {
        method: "POST",
        body: JSON.stringify({ expected: next.expected }),
        signal: AbortSignal.timeout(TURN_REQUEST_TIMEOUT_MS),
      }).then(
        (res) => !res.ok && apply({ type: "requestFailed", now: performance.now() }),
        () => apply({ type: "requestFailed", now: performance.now() }),
      );
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [apply]);

  // Script mode: R restarts the script between two rehearsals.
  useEffect(() => {
    if (!scriptMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "r" || e.key === "R") apply({ type: "resetScript", now: performance.now() });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scriptMode, apply]);

  // Chrome starts audio (microphone and voice) only after a click or a key press on the page.
  useEffect(() => {
    if (speech.state !== "needs-click") return;
    const go = () => speech.resume();
    window.addEventListener("pointerdown", go);
    window.addEventListener("keydown", go);
    return () => {
      window.removeEventListener("pointerdown", go);
      window.removeEventListener("keydown", go);
    };
  }, [speech]);

  const guestTurn = turns.phase === "requesting" || turns.phase === "guest";
  const camera: CameraState = !guestTurn ? "idle" : guest.capture?.phase === "signing" ? "signing" : "recording";

  return (
    <main className={styles.page} data-needs-click={speech.state === "needs-click" || undefined}>
      <div ref={stageRef} className={styles.stage} hidden={!webgl} />
      <GuestTurnBanner
        phase={turns.phase}
        capture={guestTurn ? (guest.capture?.phase ?? null) : null}
        said={turns.said}
        staffTalking={talk === "recording" || talk === "processing" || speech.state === "hearing" || speech.state === "processing"}
        offline={turns.offline}
      />
      {!started && (
        <button
          type="button"
          className={styles.startButton}
          onClick={() => {
            setStarted(true);
            speech.resume(); // Chrome: microphone and sound only after a user gesture
            void warmUpVoice();
            // Push-to-talk: open the microphone now (permission prompt, built-in mic) so the first press is instant.
            if (!handsFree) void ptt.start().then(() => ptt.stop(), () => setTalk("blocked"));
          }}
        >
          Start
        </button>
      )}
      {started && speech.state === "needs-click" && <div className={styles.start}>Click anywhere to start</div>}
      {speech.state === "blocked" && <div className={styles.blocked}>Microphone unavailable</div>}
      <AvatarCaptions
        text={caption.text}
        gloss={caption.gloss}
        activeIndex={activeIndex}
        large={!webgl}
        dim={!playing && caption.text !== ""}
      />
      <GuestCameraSlot state={camera} />
      <div className={styles.micState} aria-hidden>
        {handsFree ? `mic: ${speech.state}${speech.mode ? ` (${speech.mode})` : ""}` : `hold Space to talk · mic: ${talk}`}
      </div>
      {scriptMode && (
        <div className={styles.guided} aria-hidden>
          guided · step {Math.min(turns.scriptStep + 1, DEMO_SCRIPT.length)}/{DEMO_SCRIPT.length}
        </div>
      )}
    </main>
  );
}

/** Whisper transcript of a push-to-talk recording, or the browser's own transcript if Whisper fails. */
async function transcribeRecording(recording: Recording): Promise<string> {
  try {
    const text = await transcribe(recording.audio, "speech.webm");
    return /^(you|bye|\.+)[.!]*$/i.test(text) ? "" : text; // Whisper's inventions on a silent press
  } catch (err) {
    console.warn("[signbridge] Whisper failed, using the browser transcript:", err);
    return (await recording.browserText).trim();
  }
}
