"use client";
// P4 (builder B): left column of the staff screen (plan 4.2): hold-to-talk through P1's
// /api/transcribe, the reviewed free-text box (AS-26, C2-13), and the 20 quick replies (CAP-1).
// A transcript never goes to the guest without a tap on Send.
import { useRef, useState } from "react";
import { QUICK_REPLIES } from "@/components/app/displayVocab";
import { LIMITS } from "@/lib/app/types";
import type { Desk } from "./useStaffDesk";
import s from "./staff.module.css";

type Recording = { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[] };

export default function TalkPanel({ desk }: { desk: Desk }) {
  const { ui, staffAction } = desk;
  const active = ui.sessionState === "ACTIVE";
  const transcribeOn = ui.status?.flags.transcribeAvailable ?? false;
  const [text, setText] = useState("");
  const [source, setSource] = useState<"typed" | "voice">("typed");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const recRef = useRef<Recording | null>(null);

  const startRec = async () => {
    if (recRef.current || !transcribeOn) return;
    setNote(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const rec: Recording = { recorder, stream, chunks: [] };
      recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
      recorder.start();
      recRef.current = rec;
      setRecording(true);
    } catch {
      setNote("The microphone could not start. Type instead, or use a quick reply.");
    }
  };

  const stopRec = async () => {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    setRecording(false);
    const done = new Promise<void>((r) => (rec.recorder.onstop = () => r()));
    rec.recorder.stop();
    await done;
    rec.stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || "audio/webm" });
    if (blob.size === 0) return;
    if (blob.size > LIMITS.bodyAudio) return setNote("That recording was too long. Keep it under a minute.");
    setBusy(true);
    try {
      const form = new FormData();
      form.append("audio", blob, "speech.webm");
      const res = await fetch("/api/transcribe", { method: "POST", body: form, cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { text?: string } | null;
      if (res.ok && data?.text) {
        // Lands in the box for review; it is sent only after a tap on Send (C2-13).
        setText(data.text.slice(0, LIMITS.staffTextMax));
        setSource("voice");
        setNote("Check the transcript, then Send or Discard.");
      } else {
        setNote(res.status === 503 ? "Speech-to-text is off (no vendor key). Type or use a quick reply." : "Speech-to-text failed. Type or use a quick reply.");
      }
    } catch {
      setNote("Speech-to-text failed. Type or use a quick reply.");
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const clean = text.trim();
    if (!clean) return;
    setBusy(true);
    // P1's local gloss; the server re-validates every token and falls back to captions only (CAP-2).
    const g = await fetch("/api/gloss", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clean }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ gloss?: string[] }>) : null))
      .catch(() => null);
    const res = await staffAction({ type: "say_text", text: clean, gloss: Array.isArray(g?.gloss) ? g.gloss : null, source });
    setBusy(false);
    if (res && res.ok) {
      setText("");
      setSource("typed");
      setNote(null);
    }
  };

  return (
    <section className={s.column} aria-labelledby="talk-title">
      <h2 id="talk-title" className={s.colTitle}>
        Talk to the guest
      </h2>
      <button
        type="button"
        className={s.holdButton}
        data-recording={recording || undefined}
        disabled={!transcribeOn || !active || busy}
        onPointerDown={() => void startRec()}
        onPointerUp={() => void stopRec()}
        onPointerLeave={() => void stopRec()}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            void startRec();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") void stopRec();
        }}
      >
        {recording ? "Listening… release to stop" : "Hold to talk"}
      </button>
      <p className={s.hint}>
        {transcribeOn
          ? "Your speech goes to a speech-to-text service, then into the box below for you to check."
          : "Speech-to-text is off (no vendor key). Type or use a quick reply."}
      </p>

      <div className={s.field}>
        <label htmlFor="staff-text">This text will appear on the guest&apos;s device</label>
        <textarea
          id="staff-text"
          className={s.textarea}
          rows={2}
          maxLength={LIMITS.staffTextMax}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value) setSource("typed");
          }}
        />
        <div className={s.row}>
          <button type="button" className={s.primary} disabled={!active || busy || !text.trim()} onClick={() => void send()}>
            Send
          </button>
          {source === "voice" && text && (
            <button
              type="button"
              className={s.secondary}
              onClick={() => {
                setText("");
                setSource("typed");
                setNote(null);
              }}
            >
              Discard
            </button>
          )}
        </div>
        {note && <p className={s.hint}>{note}</p>}
        <p className={s.hint}>Never type the Wi-Fi password, card numbers or another guest&apos;s details here: the guest&apos;s screen shows them.</p>
      </div>

      <h3 className={s.subTitle}>Quick replies</h3>
      <div className={s.quickGrid}>
        {QUICK_REPLIES.map((q) => (
          <button key={q.key} type="button" className={s.quick} title={q.text} disabled={!active} onClick={() => void staffAction({ type: "say_quick", intent: q.key })}>
            {q.short}
          </button>
        ))}
      </div>
      {!active && <p className={s.hint}>Quick replies work once a guest window is connected.</p>}
    </section>
  );
}
