// P4: the guest's own side of /guest. The tip line, each recognized sign as a tag while they sign,
// then "You said: ..." (or a request to sign again). Sits between the avatar and the captions.
import type { CSSProperties } from "react";
import type { GuestSign, GuestUtterance } from "./useGuestEvents";

const FRAMING: Record<string, string> = {
  STEP_BACK: "Step back a little",
  MOVE_CAMERA_DOWN: "Point the camera a little lower",
  CENTER: "Move to the center",
  HANDS_OUT: "Keep your hands in view",
  NO_PERSON: "Stand in front of the camera",
};

type Props = { signs: GuestSign[]; utterance: GuestUtterance | null; framing: string | null };

export default function GuestSignPanel({ signs, utterance, framing }: Props) {
  const signing = signs.length > 0;
  const hint = framing ? FRAMING[framing] : undefined;
  return (
    <section style={styles.panel} aria-live="polite">
      {signing ? (
        <div style={styles.tags}>
          {signs.map((s) => (
            <span key={s.seq} style={styles.tag}>
              {s.top[0].label} <span style={styles.conf}>{Math.round(s.top[0].conf * 100)}%</span>
            </span>
          ))}
        </div>
      ) : utterance && utterance.needsRepeat ? (
        <p style={{ ...styles.said, ...styles.repeat }}>Sorry, could you sign that again?</p>
      ) : utterance && !utterance.mock && utterance.text ? (
        <p style={styles.said}>
          <span style={styles.saidLabel}>You said:</span> {utterance.text}
        </p>
      ) : null}
      <p style={styles.tip}>{hint ?? "Press SPACE, sign, hands down. ENTER when your sentence is done."}</p>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 10,
    padding: "14px 24px 12px",
    background: "var(--navy-900)",
    borderTop: "1px solid var(--line)",
    textAlign: "center",
  },
  tags: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 10 },
  tag: {
    padding: "6px 14px",
    borderRadius: 10,
    border: "2px solid var(--ok)",
    color: "var(--ink)",
    fontSize: "clamp(18px, 2vw, 30px)",
    fontWeight: 700,
    letterSpacing: "0.04em",
  },
  conf: { color: "var(--ink-muted)", fontWeight: 500, fontSize: "0.75em" },
  said: { margin: 0, fontSize: "clamp(20px, 2.4vw, 36px)", fontWeight: 650, color: "var(--ink)" },
  saidLabel: { color: "var(--ok)", fontWeight: 600 },
  repeat: { color: "var(--alert)" },
  tip: { margin: 0, color: "var(--ink-muted)", fontSize: "clamp(13px, 1.1vw, 17px)" },
};
