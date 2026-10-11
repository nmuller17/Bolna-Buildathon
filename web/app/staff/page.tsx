"use client";
// Optional operator console (P4). The demo runs hands-free on /guest; this page adds push-to-talk (button or Space)
// and a text field, and sends to /guest over the BroadcastChannel.
// Flow: MediaRecorder (webm) -> /api/transcribe (Whisper, P1) -> /api/gloss (P1) -> staff_utterance on the channel.
// Whisper failing falls back to the browser's speech recognition; a text field is there as a last resort.
// The guest -> staff direction is already listened to (guest_utterance, repeat_request) and shown on the right.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { toSignedSentences, transcribe } from "@/components/speechToSigns";
import { usePushToTalk, type Recording } from "@/components/usePushToTalk";
import { useSignbridgeChannel, type ChannelMessage, type ConversationTurn, type StaffState } from "@/lib/channel";
import styles from "./staff.module.css";

type Source = "whisper" | "browser" | "typed";
type Sent = { text: string; gloss: string[]; source: Source; seconds: number };
type GuestNote = { kind: "turn"; turn: ConversationTurn } | { kind: "repeat"; at: number };

const SOURCE_LABEL: Record<Source, string> = { whisper: "Whisper", browser: "browser speech (Whisper unavailable)", typed: "typed" };
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
  const [guestNotes, setGuestNotes] = useState<GuestNote[]>([]);
  const holding = useRef(false);
  const busy = useRef(false);
  const starting = useRef<Promise<void> | null>(null);

  const onMessage = useCallback((message: ChannelMessage) => {
    if (message.type === "guest_utterance") {
      const turn: ConversationTurn = { from: "guest", text: message.text, signs: message.signs, at: Date.now() };
      setGuestNotes((notes) => [{ kind: "turn", turn }, ...notes]);
      setHistory((turns) => [turn, ...turns]);
      // TODO (guest -> staff): say it aloud for the receptionist with speakSigns(message.signs) (web/components/speakSigns.ts).
    } else if (message.type === "repeat_request") {
      setGuestNotes((notes) => [{ kind: "repeat", at: Date.now() }, ...notes]);
    }
  }, []);
  const send = useSignbridgeChannel(onMessage);

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
                via {SOURCE_LABEL[last.source]} · {last.seconds.toFixed(1)} s
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
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Guest messages</h2>
          {guestNotes.length === 0 ? (
            <p className={styles.empty}>Coming soon: messages signed by the guest.</p>
          ) : (
            <ul className={styles.list}>
              {guestNotes.map((note, i) =>
                note.kind === "turn" ? (
                  <li key={i} className={styles.guestTurn}>
                    <span className={styles.guestText}>{note.turn.text}</span>
                    <span className={styles.meta}>
                      {note.turn.signs?.map((s) => `${s.label} ${Math.round(s.conf * 100)}%`).join(" · ")} · {time(note.turn.at)}
                    </span>
                  </li>
                ) : (
                  <li key={i} className={styles.repeat}>
                    Guest asked to sign again · {time(note.at)}
                  </li>
                ),
              )}
            </ul>
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
