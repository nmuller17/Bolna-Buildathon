// P4: push-to-talk recorder for /staff. Based on web/app/p1-test (P1), which P1 can move into web/lib/voice later.
// While the button is held: MediaRecorder records webm for /api/transcribe (Whisper), and the browser's own speech
// recognition (Web Speech API, Chrome) listens in parallel, so its transcript is ready if Whisper fails (CLAUDE.md rule 7).
// The microphone stays open after the first press: the next press starts instantly and the first word is not cut.
import { useCallback, useEffect, useRef } from "react";

const MIN_PRESS_MS = 250; // shorter presses are treated as accidental
const SPEECH_WAIT_MS = 2500; // how long to wait for the browser's final transcript after release

// Minimal Web Speech API types (not in TypeScript's DOM lib).
type SpeechResultList = ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: SpeechResultList }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export type Recording = {
  audio: Blob; // webm, for /api/transcribe
  browserText: Promise<string>; // Web Speech transcript ("" if unavailable)
};

function speechRecognition(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function usePushToTalk() {
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const speech = useRef<{ recognizer: SpeechRecognitionLike; text: string[]; done: Promise<void> } | null>(null);

  useEffect(
    () => () => {
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
    },
    [],
  );

  /** Starts recording. Throws if the microphone is blocked. */
  const start = useCallback(async () => {
    if (recorder.current?.state === "recording") return;
    stream.current ??= await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    const rec = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined);
    chunks.current = [];
    rec.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data);
    };
    rec.start();
    recorder.current = rec;
    startedAt.current = performance.now();

    const Recognition = speechRecognition();
    speech.current = null;
    if (Recognition) {
      try {
        const recognizer = new Recognition();
        recognizer.lang = "en-US";
        recognizer.continuous = true;
        recognizer.interimResults = false;
        const text: string[] = [];
        recognizer.onresult = (event) => {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            if (result.isFinal) text.push(result[0].transcript.trim());
          }
        };
        const done = new Promise<void>((resolve) => {
          recognizer.onend = () => resolve();
          recognizer.onerror = () => resolve();
        });
        recognizer.start();
        speech.current = { recognizer, text, done };
      } catch {
        speech.current = null; // the fallback is optional
      }
    }
  }, []);

  /** Stops recording. Resolves with null for an accidental tap or if nothing was recording. */
  const stop = useCallback(async (): Promise<Recording | null> => {
    const rec = recorder.current;
    if (!rec || rec.state !== "recording") return null;
    const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
    rec.stop();
    recorder.current = null;

    const sp = speech.current;
    speech.current = null;
    sp?.recognizer.stop();
    const browserText = sp
      ? Promise.race([sp.done, new Promise<void>((r) => setTimeout(r, SPEECH_WAIT_MS))]).then(() => sp.text.join(" ").trim())
      : Promise.resolve("");

    await stopped;
    if (performance.now() - startedAt.current < MIN_PRESS_MS) return null;
    return { audio: new Blob(chunks.current, { type: rec.mimeType || "audio/webm" }), browserText };
  }, []);

  return { start, stop };
}
