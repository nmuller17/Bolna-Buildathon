"use client";
// P4 guest screen: pieces shared by GuestApp and the features-plan components (picture board, typed
// "Did you mean...?", number pad). Moved out of GuestApp.tsx unchanged, so every sentence still goes
// through the one BN-1 confirmation: the exact sentence, then "Say it", "Text only" and "Fix".
import { useEffect, useState } from "react";
import { KeyTag, SimulatedBadge, TrafficLight } from "@/components/app/KeyTag";
import { nameProblem } from "@/components/app/displayVocab";
import { GUEST_HONEST_LINES, type GuestSignView } from "@/lib/app/types";
import s from "./guest.module.css";
import type { ActionOutcome, GuestUi, useGuestSession } from "./useGuestSession";

export type Session = ReturnType<typeof useGuestSession>;

export const isTyping = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
};

/** Kiosk inputs (every team-owned device): no autocomplete, autocorrect, capitalisation or spellcheck (AS-8). */
export const kioskInput = (kiosk: boolean) =>
  kiosk ? ({ autoComplete: "off", autoCorrect: "off", autoCapitalize: "off", spellCheck: false } as const) : {};

export const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** True when the guest allowed reading aloud and is not in Text only mode (C2-22). */
export const canSpeak = (ui: GuestUi) => ui.settings.speakAloud && ui.settings.guestMode !== "text_only";

export function SignRow({ signs, simulated }: { signs: GuestSignView[]; simulated: boolean }) {
  return (
    <ul className={s.signRow} aria-label="Signs the camera read">
      {simulated && (
        <li>
          <SimulatedBadge />
        </li>
      )}
      {signs.map((sg, i) => (
        <li key={`${sg.seq ?? "x"}-${i}`} className={s.signItem}>
          <KeyTag token={sg.label === "NONE" ? "no sign" : sg.label} missed={sg.light === "red"} />
          <TrafficLight light={sg.light} surface="guest" />
        </li>
      ))}
    </ul>
  );
}

export type Confirmable = { text: string; needsName: boolean };
export type SendHow = { voice: boolean; name?: string };

/**
 * The one confirmation every sentence goes through: the exact sentence, the signs it came from, and
 * three equal buttons. "Say it" lets the desk read it aloud; "Text only" shows it at the desk with no
 * voice; "Fix" never re-runs recognition by itself (BN-1).
 */
export function ConfirmCard(props: {
  ui: GuestUi;
  item: Confirmable;
  signs: GuestSignView[] | null;
  simulated: boolean;
  testMode: boolean;
  headingRef?: React.RefObject<HTMLHeadingElement | null>;
  heading?: string;
  onSend: (how: SendHow) => Promise<ActionOutcome>;
  fixOptions: { label: string; run: () => void }[];
}) {
  const { ui, item, signs, simulated, testMode } = props;
  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const speak = canSpeak(ui);

  const send = async (voice: boolean) => {
    let typedName: string | undefined;
    if (item.needsName) {
      const problem = nameProblem(name);
      if (problem) return setNameErr(problem);
      typedName = name.normalize("NFC").trim();
    }
    setBusy(true);
    setError(null);
    const r = await props.onSend({ voice, ...(typedName ? { name: typedName } : {}) });
    setBusy(false);
    if (!r.ok) {
      if (r.field === "name") setNameErr(r.message);
      else setError(r.message);
    }
  };

  const sentence = item.needsName ? `My name is ${name.trim() || "..."}` : item.text;

  return (
    <div className={s.confirm}>
      {props.heading && <p className={s.small}>{props.heading}</p>}
      <h3 ref={props.headingRef} tabIndex={-1} className={s.proposalHeading}>
        &ldquo;{sentence}&rdquo;
      </h3>
      {signs && signs.length > 0 && <SignRow signs={signs} simulated={simulated} />}
      {testMode && <p className={s.framingAlert}>Test mode: these signs were invented by a test program and will not be spoken.</p>}
      {item.needsName && <NameField name={name} setName={setName} error={nameErr} setError={setNameErr} kiosk={ui.hello?.kiosk ?? true} />}
      {signs && signs.length > 0 && <p className={s.small}>{GUEST_HONEST_LINES.face}</p>}
      <div className={s.confirmButtons} data-count={speak ? 3 : 2} data-actions="">
        {speak && (
          <button type="button" className={s.primary} disabled={busy || testMode} onClick={() => void send(true)}>
            Say it
          </button>
        )}
        <button type="button" className={speak ? s.secondary : s.primary} disabled={busy || testMode} onClick={() => void send(false)}>
          {speak ? "Text only" : "Send as text"}
        </button>
        <button type="button" className={s.secondary} disabled={busy} aria-expanded={fixOpen} onClick={() => setFixOpen((v) => !v)}>
          Fix
        </button>
      </div>
      <p className={s.small}>
        {speak
          ? item.needsName
            ? "Say it: your name appears on the desk screen, and staff read it aloud on this laptop's own voice. Text only: it is never read aloud."
            : "Say it: the desk reads this sentence aloud. Text only: it appears on the desk screen with no voice."
          : "Reading aloud is off. The sentence appears on the desk screen with no voice."}
      </p>
      {fixOpen && (
        <div className={s.buttonRow} role="group" aria-label="Fix">
          {props.fixOptions.map((f) => (
            <button key={f.label} type="button" className={s.secondary} onClick={f.run}>
              {f.label}
            </button>
          ))}
        </div>
      )}
      {error && <p className={s.error}>{error}</p>}
    </div>
  );
}

export function NameField(props: { name: string; setName: (v: string) => void; error: string | null; setError: (v: string | null) => void; kiosk: boolean }) {
  return (
    <div className={s.field}>
      <label htmlFor="guest-name">Type your name</label>
      <input
        id="guest-name"
        className={s.input}
        value={props.name}
        maxLength={60}
        aria-invalid={!!props.error}
        aria-describedby={props.error ? "guest-name-error" : undefined}
        onChange={(e) => {
          props.setName(e.target.value);
          props.setError(null);
        }}
        {...kioskInput(props.kiosk)}
      />
      {props.error && (
        <p id="guest-name-error" className={s.error}>
          {props.error}
        </p>
      )}
    </div>
  );
}
