// P4 (builder B): the brass key tag, the traffic light and the SIMULATED badge, shared by both screens.
import { LIGHT_WORDS_GUEST, LIGHT_WORDS_STAFF, RED_REASON_STAFF, type RedReason, type TrafficLight as Light } from "@/lib/app/types";
import { tagText } from "./displayVocab";
import s from "./keytag.module.css";

type TagProps = {
  token: string;
  missed?: boolean;
  active?: boolean;
  small?: boolean;
  children?: React.ReactNode;
};

/** One gloss word or recognised sign. Missed signs are grey outlines, never red (A11Y-5). */
export function KeyTag({ token, missed = false, active = false, small = false, children }: TagProps) {
  const cls = [s.tag, missed && s.missed, active && s.active, small && s.small].filter(Boolean).join(" ");
  return (
    <span className={cls}>
      <span>{tagText(token)}</span>
      {children}
    </span>
  );
}

type LightProps = {
  light: Light;
  surface: "guest" | "staff";
  /** Staff only: the red reason replaces the generic words (never blames the guest, C2-5). */
  red?: RedReason | null;
  /** Hide the word (the caller shows it elsewhere). The shape is always drawn. */
  wordless?: boolean;
};

/**
 * Traffic light: a filled, half-filled or hollow circle plus a word, never colour alone.
 * Guest words: clear / not certain / missed; staff words name the model score (plan 4.1).
 */
export function TrafficLight({ light, surface, red = null, wordless = false }: LightProps) {
  const word =
    surface === "guest" ? LIGHT_WORDS_GUEST[light] : light === "red" && red ? RED_REASON_STAFF[red] : LIGHT_WORDS_STAFF[light];
  return (
    <span className={`${s.light} ${s[surface]} ${s[light]}`}>
      <span className={s.dot} aria-hidden="true" />
      {wordless ? <span className="sr-only">{word}</span> : <span>{word}</span>}
    </span>
  );
}

/** Shown on every simulated sign and proposal, on both screens (plan 6.7). */
export function SimulatedBadge() {
  return <span className={s.badge}>SIMULATED</span>;
}
