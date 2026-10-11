"use client";
// How the guest talks (docs/features-plan.md F12, F13).
//
// - First screen: five equal choices, one tap each: I sign, Read and type, Tap pictures, Read only
//   (no avatar), Human interpreter. The camera is used only after "I sign" (recognition is gated on
//   the server).
// - "I sign" asks which sign language first, with ASL first. Any other language shows
//   SIGN_LANGUAGE_NOT_YET and reaches typing, pictures or an interpreter in one more tap. The language
//   stays in this page's memory; the server never receives it unless the guest shares it on the
//   interpreter card (F11).
// - ModeSwitch: the same five choices in the header of every later screen, one tap each.
import { useEffect, useRef, useState } from "react";
import {
  GUEST_HONEST_LINES,
  GUEST_NOTICE,
  GUEST_NOTICE_EXTRA,
  SIGN_CARD_TEXT,
  SIGN_LANGUAGE_NOT_YET,
  SIGN_LANGUAGES,
  type GuestMode,
  type SignLanguage,
} from "@/lib/app/types";
import type { Session } from "./common";
import s from "./guest.module.css";

export type Choice = Exclude<GuestMode, "choosing">;

type IconKind = "sign" | "type" | "tap" | "text" | "interpreter";

const ICON_PATH: Record<IconKind, string> = {
  sign: "M7 21v-6.5L4.6 9.8a1.4 1.4 0 0 1 2.4-1.4L9 11V4.5a1.3 1.3 0 0 1 2.6 0V10m0-5.8a1.3 1.3 0 0 1 2.6 0V10m0-4.3a1.3 1.3 0 0 1 2.6 0V11m0-3a1.3 1.3 0 0 1 2.6 0v6.5c0 3.6-2.4 6.5-6 6.5",
  type: "M3 7h18v10H3zM6 10h1m3 0h1m3 0h1m3 0h1M7 14h10",
  tap: "M3.5 3.5h7v7h-7zM13.5 3.5h7v7h-7zM3.5 13.5h7v7h-7zM13.5 13.5h7v7h-7z",
  interpreter: "M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 9c0-3 2.2-5 5-5s5 2 5 5M16 8.5a2.5 2.5 0 1 0 0-5M17 12.6c2 .5 3.5 2.3 3.5 4.9",
  text: "M4 6h16M4 10h16M4 14h11M4 18h8",
};

export function ChoiceIcon({ kind, className }: { kind: IconKind; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className ?? s.choiceIcon}>
      <path d={ICON_PATH[kind]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ICON_OF: Record<Choice, IconKind> = { sign: "sign", type: "type", tap: "tap", text_only: "text", interpreter: "interpreter" };

/** The five choices, in this order everywhere (first screen and header). */
export const CHOICES: { choice: Choice; title: string; short: string; text: string }[] = [
  { choice: "sign", title: "I sign", short: "Sign", text: SIGN_CARD_TEXT },
  { choice: "type", title: "Read and type", short: "Type", text: "Read the desk's words and type back, or pick one of 20 common requests." },
  { choice: "tap", title: "Tap pictures", short: "Pictures", text: "Tap a picture for towels, Wi-Fi, breakfast, a taxi and more." },
  { choice: "text_only", title: "Read only", short: "Read only", text: "Read the desk's words as text, with no avatar." },
  { choice: "interpreter", title: "Human interpreter", short: "Interpreter", text: "The desk arranges a sign language interpreter. This may take time." },
];

const SIGN_OFF_TEXT = "Signing is not available right now. Please type, tap pictures or ask for an interpreter.";

export function AboutScreen({ emergencyNote }: { emergencyNote: string }) {
  return (
    <>
      <details className={s.about}>
        <summary>About this screen</summary>
        <p>{GUEST_NOTICE}</p>
        {GUEST_NOTICE_EXTRA.map((t) => (
          <p key={t}>{t}</p>
        ))}
      </details>
      {emergencyNote && <p className={s.muted}>{emergencyNote}</p>}
    </>
  );
}

/** Which sign language (F13). ASL first and preselected; one tap starts signing. */
function SignLanguageStep(props: {
  language: SignLanguage;
  setLanguage: (l: SignLanguage) => void;
  onSign: () => void;
  onOther: (c: Choice) => void;
  onBack: () => void;
}) {
  const [picked, setPicked] = useState<SignLanguage | null>(null);
  const other = picked && picked !== "ase" ? SIGN_LANGUAGES.find((l) => l.code === picked) : null;
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (picked && picked !== "ase") cardRef.current?.scrollIntoView({ block: "nearest" });
  }, [picked]);
  return (
    <div className={s.first}>
      <h1 className={s.title}>Which sign language?</h1>
      {/* Shown above the list, so the next step is on screen without scrolling (390x844, 844x390). */}
      {other && (
        <div className={s.card} role="status" ref={cardRef}>
          <p className={s.cardText}>{SIGN_LANGUAGE_NOT_YET}</p>
          <div className={s.buttonRow}>
            <button type="button" className={s.primary} onClick={() => props.onOther("type")}>
              Type
            </button>
            <button type="button" className={s.secondary} onClick={() => props.onOther("tap")}>
              Tap pictures
            </button>
            <button type="button" className={s.secondary} onClick={() => props.onOther("interpreter")}>
              Ask for an interpreter
            </button>
          </div>
        </div>
      )}
      <div className={s.langList} role="group" aria-label="Sign languages">
        {SIGN_LANGUAGES.map((l) => (
          <button
            key={l.code}
            type="button"
            className={l.code === "ase" ? s.langPrimary : s.langButton}
            aria-pressed={picked === l.code || (picked === null && l.code === "ase") || undefined}
            onClick={() => {
              props.setLanguage(l.code);
              if (l.recognised) props.onSign();
              else setPicked(l.code);
            }}
          >
            <span className={s.langName}>{l.name}</span>
            {l.recognised ? <span className={s.langNote}>Start signing</span> : <span className={s.langNote}>Coming later</span>}
          </button>
        ))}
      </div>
      <button type="button" className={s.quiet} onClick={props.onBack}>
        Back to all choices
      </button>
    </div>
  );
}

export function FirstScreen(props: { session: Session; language: SignLanguage; setLanguage: (l: SignLanguage) => void }) {
  const { session, language, setLanguage } = props;
  const { ui, act, requestInterpreter } = session;
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"choices" | "language">("choices");
  const speakAloud = ui.settings.speakAloud;

  const choose = async (choice: Choice) => {
    setError(null);
    const r = await act({ type: "guest_choice", choice });
    if (!r.ok) return setError(r.message);
    if (choice === "interpreter") await requestInterpreter();
  };

  if (step === "language") {
    return (
      <>
        <SignLanguageStep
          language={language}
          setLanguage={setLanguage}
          onSign={() => void choose("sign")}
          onOther={(c) => void choose(c)}
          onBack={() => setStep("choices")}
        />
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
      </>
    );
  }

  return (
    <div className={s.first}>
      <h1 className={s.title}>How would you like to talk with the front desk?</h1>
      <div className={s.choices}>
        {CHOICES.map((c) => {
          const off = c.choice === "sign" && !ui.signingAvailable;
          return (
            <button
              key={c.choice}
              type="button"
              className={s.choice}
              disabled={off}
              onClick={() => (c.choice === "sign" ? setStep("language") : void choose(c.choice))}
            >
              <ChoiceIcon kind={ICON_OF[c.choice]} />
              <span className={s.choiceTitle}>{c.title}</span>
              <span className={s.choiceText}>{off ? SIGN_OFF_TEXT : c.text}</span>
            </button>
          );
        })}
      </div>
      {error && (<p className={s.error} role="alert">{error}</p>)}
      <label className={s.check}>
        <input type="checkbox" checked={speakAloud} onChange={(e) => void act({ type: "prefs", speakAloud: e.target.checked })} />
        <span>
          Read my sentences aloud at the desk. <span className={s.muted}>People nearby will hear it. You still choose each time.</span>
        </span>
      </label>
      <ul className={s.honest}>
        <li>{GUEST_HONEST_LINES.camera}</li>
        <li>{GUEST_HONEST_LINES.keeps}</li>
        <li>{GUEST_HONEST_LINES.mistakes}</li>
      </ul>
      <AboutScreen emergencyNote={ui.hello?.emergencyNote ?? ""} />
    </div>
  );
}

/** The same five choices in the header, one tap each (F12 E1). */
export function ModeSwitch({ session }: { session: Session }) {
  const { ui, act, requestInterpreter } = session;
  const mode = ui.settings.guestMode;
  const [error, setError] = useState<string | null>(null);
  const pick = async (choice: Choice) => {
    setError(null);
    if (choice === mode && choice !== "interpreter") return;
    const r = await act({ type: "guest_choice", choice });
    if (!r.ok) return setError(r.message);
    if (choice === "interpreter" && ui.interpreter === "none") await requestInterpreter();
  };
  return (
    <div className={s.modeSwitchWrap}>
      <div className={s.modeSwitch} role="group" aria-label="How I talk">
        {CHOICES.map((c) => (
          <button
            key={c.choice}
            type="button"
            className={s.modeButton}
            aria-pressed={mode === c.choice}
            // Not disabled when signing is down: a greyed-out button gives no reason. The tap gets the
            // server's plain answer ("Signing is not available right now...") in the alert below.
            onClick={() => void pick(c.choice)}
          >
            <ChoiceIcon kind={ICON_OF[c.choice]} className={s.modeIcon} />
            <span>{c.short}</span>
          </button>
        ))}
      </div>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function DisplayOnlyChoices() {
  return (
    <div className={s.first}>
      <h1 className={s.title}>The desk will ask how you want to talk. Point to one:</h1>
      <div className={s.choices} aria-label="Choices on the card at the desk">
        {CHOICES.map((c) => (
          <div key={c.choice} className={`${s.choice} ${s.choiceStatic}`}>
            <ChoiceIcon kind={ICON_OF[c.choice]} />
            <span className={s.choiceTitle}>{c.title}</span>
          </div>
        ))}
      </div>
      <p className={s.lead}>{SIGN_CARD_TEXT}</p>
    </div>
  );
}
