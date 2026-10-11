"use client";
// Typed numbers (docs/features-plan.md F7): digits only, with what the number is about. The desk sees
// it large ("Guest typed: 3 (nights)") and never voices it without a staff tap. Big keys for a kiosk,
// plus an ordinary field for a keyboard.
import { useEffect, useState } from "react";
import { numberProblem } from "@/lib/app/guestfeatures";
import { FEATURE_LIMITS, NUMBER_ABOUT_LABEL, type NumberAbout } from "@/lib/app/types";
import { kioskInput, type Session } from "./common";
import s from "./guest.module.css";

const ABOUT_ORDER: NumberAbout[] = ["nights", "people", "room", "other"];
const ABOUT_BUTTON: Record<NumberAbout, string> = { nights: "Nights", people: "People", room: "Room number", other: "Something else" };
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"] as const;

export default function NumberPad({ session, suggestAbout, onDone }: { session: Session; suggestAbout?: NumberAbout | null; onDone?: () => void }) {
  const { ui, sendNumber, unsentRef } = session;
  const [value, setValue] = useState("");
  const [about, setAbout] = useState<NumberAbout>(suggestAbout ?? "nights");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (suggestAbout) setAbout(suggestAbout);
  }, [suggestAbout]);
  useEffect(() => {
    unsentRef.current = value.length > 0;
  }, [value, unsentRef]);

  const press = (k: (typeof KEYS)[number]) => {
    setError(null);
    setSent(null);
    if (k === "del") return setValue((v) => v.slice(0, -1));
    if (k === "") return;
    setValue((v) => (v.length >= FEATURE_LIMITS.guestNumberMaxDigits ? v : v + k));
  };

  const send = async () => {
    const problem = numberProblem(value);
    if (problem) return setError(problem);
    setBusy(true);
    const r = await sendNumber(about, value);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setSent(`${value} (${NUMBER_ABOUT_LABEL[about]})`);
    setValue("");
    onDone?.();
  };

  return (
    <div className={s.numberPad}>
      <p className={s.subTitle} id="num-about">
        The number is for
      </p>
      <div className={s.buttonRow} role="group" aria-labelledby="num-about">
        {ABOUT_ORDER.map((a) => (
          <button key={a} type="button" className={s.chip} aria-pressed={about === a} onClick={() => setAbout(a)}>
            {ABOUT_BUTTON[a]}
          </button>
        ))}
      </div>
      <div className={s.field}>
        <label htmlFor="guest-number">Type the number</label>
        <input
          id="guest-number"
          className={`${s.input} ${s.numberInput}`}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={FEATURE_LIMITS.guestNumberMaxDigits}
          value={value}
          aria-invalid={!!error}
          aria-describedby={error ? "guest-number-error" : "guest-number-help"}
          onChange={(e) => {
            // Digits only, kept as typed; the reason appears only on Send.
            setValue(e.target.value.replace(/\s/g, "").slice(0, FEATURE_LIMITS.guestNumberMaxDigits + 2));
            setError(null);
            setSent(null);
          }}
          {...kioskInput(ui.hello?.kiosk ?? true)}
        />
        <p id="guest-number-help" className={s.small}>
          Digits only, up to {FEATURE_LIMITS.guestNumberMaxDigits}. The desk sees it on screen; it is not read aloud.
        </p>
        {error && (
          <p id="guest-number-error" className={s.error}>
            {error}
          </p>
        )}
      </div>
      <div className={s.keypad} role="group" aria-label="Number keys">
        {KEYS.map((k, i) =>
          k === "" ? (
            <span key={i} aria-hidden="true" />
          ) : (
            <button key={i} type="button" className={s.key} aria-label={k === "del" ? "Delete last digit" : k} onClick={() => press(k)}>
              {k === "del" ? "⌫" : k}
            </button>
          ),
        )}
      </div>
      <button type="button" className={s.primary} disabled={busy} onClick={() => void send()}>
        Send the number
      </button>
      {sent && (
        <p className={s.small} role="status">
          Sent to the desk: {sent}
        </p>
      )}
    </div>
  );
}
