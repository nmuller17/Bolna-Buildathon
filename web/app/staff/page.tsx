"use client";
// Receptionist screen (P4), on the staff laptop.
// Guest -> staff: what the guest signs (recognizer -> /api/guest/signs -> /api/guest/stream) shows big on the right
// and is spoken aloud (/api/tts, browser voice as fallback). The first click on the page unlocks sound.
// Staff -> guest runs hands-free on /guest; this page also offers push-to-talk (button or Space) and a text field,
// sent to /guest over the BroadcastChannel (MediaRecorder -> /api/transcribe -> /api/gloss -> staff_utterance).
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { speakText, warmUpVoice } from "@/components/speakSigns";
import { toSignedSentences, transcribe } from "@/components/speechToSigns";
import { useGuestEvents, type GuestUtterance } from "@/components/useGuestEvents";
import { usePushToTalk, type Recording } from "@/components/usePushToTalk";
import { useSignbridgeChannel, type ChannelMessage, type ConversationTurn, type StaffState } from "@/lib/channel";
import styles from "./staff.module.css";

type Source = "whisper" | "browser" | "typed" | "guest";
type Sent = { text: string; gloss: string[]; source: Source; seconds: number };

const SOURCE_LABEL: Record<Source, string> = {
  whisper: "Whisper",
  browser: "browser speech (Whisper unavailable)",
  typed: "typed",
  guest: "the guest screen's microphone",
};
const GUEST_SOURCE: Record<GuestUtterance["source"], string> = {
  recognizer: "known sentence",
  english: "worded by /api/english",
  words: "signs as words",
};
const STALE_SPEECH_S = 15; // a sentence that waited longer for the sound to be unlocked is not spoken late
const BUTTON_LABEL: Record<StaffState, string> = { idle: "Hold to talk", listening: "Listening…", processing: "Translating…" };
const STATUS_LABEL: Record<StaffState, string> = { idle: "Ready", listening: "Listening", processing: "Translating" };

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Whisper first; if it fails or takes too long, the transcript the browser made in parallel. */
async function transcribeRecording(recording: Recording): Promise<{ text: string; source: Source }> {
  try {
    const text = await transcribe(recording.audio, "speech.webm");
    if (text) return { text, source: "whisper" };
  } catch (err) {
    console.warn("[staff] Whisper failed, using the browser transcript:", err);
  }
  return { text: await recording.browserText, source: "browser" };
}

export default function StaffPage() {
  const ptt = usePushToTalk();
  const [state, setState] = useState<StaffState>("idle");
  const [last, setLast] = useState<Sent | null>(null);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const [history, setHistory] = useState<ConversationTurn[]>([]);
  const [soundOn, setSoundOn] = useState(false);
  const holding = useRef(false);
  const busy = useRef(false);
  const starting = useRef<Promise<void> | null>(null);

  const soundRef = useRef(false);
  const waiting = useRef<{ text: string; at: number } | null>(null); // latest sentence, until sound is unlocked
  const speaking = useRef(Promise.resolve());

  // CLAUDE.md 6.7 messages from another window. staff_utterance: what /guest heard and signed (hands-free).
  // guest_utterance / repeat_request: older path, the recognizer now posts to /api/guest/signs.
  const onMessage = useCallback((message: ChannelMessage) => {
    if (message.type === "staff_utterance") {
      setLast({ text: message.text, gloss: message.gloss, source: "guest", seconds: 0 });
      setHistory((turns) => [{ from: "staff", text: message.text, gloss: message.gloss, at: Date.now() }, ...turns]);
    } else if (message.type === "guest_utterance") {
      setHistory((turns) => [{ from: "guest", text: message.text, signs: message.signs, at: Date.now() }, ...turns]);
    } else if (message.type === "repeat_request") {
      setHistory((turns) => [{ from: "guest", text: "(asked to sign again)", at: Date.now() }, ...turns]);
    }
  }, []);
  const send = useSignbridgeChannel(onMessage);

  /** Speaks one sentence after the other; /guest mutes its microphone meanwhile (voice_output). */
  const say = useCallback(
    (text: string) => {
      speaking.current = speaking.current.then(async () => {
        send({ type: "voice_output", playing: true });
        try {
          await speakText(text);
        } finally {
          send({ type: "voice_output", playing: false });
        }
      });
    },
    [send],
  );

  const onGuestUtterance = useCallback(
    (u: GuestUtterance) => {
      const text = u.needsRepeat ? "(asked to sign again)" : u.text;
      setHistory((turns) => [{ from: "guest", text, gloss: u.labels, at: Date.now() }, ...turns]);
      if (u.needsRepeat || u.mock || !u.text) return; // never speak a guess
      if (soundRef.current) say(u.text);
      else waiting.current = { text: u.text, at: Date.now() / 1000 };
    },
    [say],
  );
  const guest = useGuestEvents(onGuestUtterance);

  // Compiles /api/tts and pre-generates the known guest sentences with Piper, so the first one speaks without delay.
  useEffect(() => {
    void warmUpVoice();
  }, []);

  // Browsers only play sound after the page got a click or a key press.
  useEffect(() => {
    const unlock = () => {
      if (soundRef.current) return;
      soundRef.current = true;
      setSoundOn(true);
      const w = waiting.current;
      waiting.current = null;
      if (w && Date.now() / 1000 - w.at < STALE_SPEECH_S) say(w.text);
    };
    if ((navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive) unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [say]);

  const setStatus = useCallback(
    (next: StaffState) => {
      setState(next);
      send({ type: "staff_status", state: next });
    },
    [send],
  );

  /** English text -> guest screen, one staff_utterance per sentence (see toSignedSentences). */
  const deliver = useCallback(
    async (text: string, source: Source, since: number) => {
      const sentences = await toSignedSentences(text);
      if (sentences.length === 0) throw new Error("Nothing to sign in this sentence.");
      for (const s of sentences) send({ type: "staff_utterance", text: s.text, gloss: s.gloss });
      const gloss = sentences.flatMap((s) => s.gloss);
      setLast({ text, gloss, source, seconds: (performance.now() - since) / 1000 });
      setHistory((turns) => [{ from: "staff", text, gloss, at: Date.now() }, ...turns]);
    },
    [send],
  );

  const pressStart = useCallback(() => {
    if (holding.current || busy.current) return;
    holding.current = true;
    setError("");
    setStatus("listening");
    starting.current = ptt.start().catch(() => {
      holding.current = false;
      setStatus("idle");
      setError("Microphone blocked. Allow it in the browser, or type the sentence below.");
    });
  }, [ptt, setStatus]);

  const pressEnd = useCallback(async () => {
    if (!holding.current) return;
    holding.current = false;
    busy.current = true;
    setStatus("processing");
    const since = performance.now();
    try {
      await starting.current; // a very quick release can land before the microphone has started
      const recording = await ptt.stop();
      if (!recording) return;
      const { text, source } = await transcribeRecording(recording);
      if (!text) throw new Error("No speech recognized. Try again, or type the sentence below.");
      await deliver(text, source, since);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      busy.current = false;
      setStatus("idle");
    }
  }, [ptt, deliver, setStatus]);

  async function submitTyped(event: FormEvent) {
    event.preventDefault();
    const text = typed.trim();
    if (!text || busy.current || holding.current) return;
    busy.current = true;
    setError("");
    setStatus("processing");
    try {
      await deliver(text, "typed", performance.now());
      setTyped("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      busy.current = false;
      setStatus("idle");
    }
  }

  // Space bar = push-to-talk, except while typing in the text field.
  useEffect(() => {
    const typing = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e.target)) return;
      e.preventDefault();
      if (!e.repeat) pressStart();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e.target)) return;
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
  }, [pressStart, pressEnd]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brand}>
          SignBridge <span className={styles.brandSub}>Front desk</span>
        </span>
        <span className={styles.status} data-state={state}>
          <i aria-hidden /> {STATUS_LABEL[state]}
        </span>
        <a className={styles.guestLink} href="/guest" target="signbridge-guest">
          Open guest screen ↗
        </a>
      </header>

      <section className={styles.talk}>
        <button
          type="button"
          className={styles.talkButton}
          data-state={state}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            pressStart();
          }}
          onPointerUp={() => void pressEnd()}
          onPointerCancel={() => void pressEnd()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className={styles.mic} aria-hidden />
          {BUTTON_LABEL[state]}
        </button>
        <p className={styles.hint}>Hold the button or the space bar while you speak, release to send.</p>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Sent to the guest</h2>
          {last ? (
            <>
              <p className={styles.sentText}>{last.text}</p>
              <div className={styles.gloss}>
                {last.gloss.map((token, i) => (
                  <span key={i} className={styles.token}>
                    {token}
                  </span>
                ))}
              </div>
              <p className={styles.meta}>
                via {SOURCE_LABEL[last.source]}
                {last.seconds > 0 && ` · ${last.seconds.toFixed(1)} s`}
              </p>
            </>
          ) : (
            <p className={styles.empty}>Nothing yet. What you say appears here with the signs sent to the guest.</p>
          )}
        </div>

        <form className={styles.typed} onSubmit={submitTyped}>
          <input
            className={styles.input}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Or type a sentence…"
            aria-label="Sentence to sign"
          />
          <button type="submit" className={styles.sendButton} disabled={!typed.trim() || state !== "idle"}>
            Send
          </button>
        </form>
      </section>

      <aside className={styles.side}>
        <div className={`${styles.card} ${styles.guestCard}`}>
          <h2 className={styles.cardTitle}>Guest</h2>
          {!soundOn && (
            <button type="button" className={styles.soundButton}>
              Click to turn the sound on
            </button>
          )}
          {guest.signs.length > 0 && (
            <div className={styles.signing}>
              <span className={styles.meta}>Signing…</span>
              {guest.signs.map((s) => (
                <span key={s.seq} className={styles.token}>
                  {s.top[0].label} {Math.round(s.top[0].conf * 100)}%
                </span>
              ))}
            </div>
          )}
          {guest.utterance ? (
            <>
              {guest.utterance.needsRepeat ? (
                <p className={styles.repeat}>The guest is asked to sign again.</p>
              ) : (
                <p className={styles.guestSentence}>{guest.utterance.text}</p>
              )}
              <div className={styles.gloss}>
                {guest.utterance.labels.map((label, i) => (
                  <span key={i} className={styles.token}>
                    {label}
                  </span>
                ))}
              </div>
              {guest.utterance.raw.join(" ") !== guest.utterance.labels.join(" ") && (
                <p className={styles.raw}>recognized: {guest.utterance.raw.join(" ")}</p>
              )}
              <p className={styles.meta}>
                {GUEST_SOURCE[guest.utterance.source]} · {time(guest.utterance.at * 1000)}
                {guest.utterance.mock && " · recognizer in mock mode, not spoken"}
              </p>
            </>
          ) : (
            <p className={styles.empty}>
              {guest.connected ? "Waiting for the guest to sign." : "Connecting to the recognizer stream…"}
            </p>
          )}
        </div>

        <div className={`${styles.card} ${styles.historyCard}`}>
          <h2 className={styles.cardTitle}>Conversation</h2>
          {history.length === 0 ? (
            <p className={styles.empty}>The conversation will show here.</p>
          ) : (
            <ul className={styles.list}>
              {history.map((turn, i) => (
                <li key={i} className={styles.turn} data-from={turn.from}>
                  <span className={styles.who}>{turn.from === "staff" ? "You" : "Guest"}</span>
                  <span className={styles.turnText}>{turn.text}</span>
                  <span className={styles.time}>{time(turn.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </main>
  );
}
