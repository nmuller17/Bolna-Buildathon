// P4: captions under the avatar. English sentence, then the gloss tokens with the one being signed lit up (karaoke).
import type { CSSProperties } from "react";

type Props = {
  text?: string;
  gloss: string[];
  /** Gloss index being signed (from playGloss's onToken), or null. */
  activeIndex: number | null;
  /** Fills the screen with bigger text, used when the avatar cannot render. */
  large?: boolean;
  /** Faded: the last sentence, kept on screen while the avatar rests. */
  dim?: boolean;
};

const MARKERS: Record<string, string> = { "BROWS-UP": "brows up ↑", "BROWS-DOWN": "brows down ↓" };

const label = (token: string) => (token.startsWith("FS:") ? `fs-${token.slice(3)}` : token);

export default function AvatarCaptions({ text, gloss, activeIndex, large = false, dim = false }: Props) {
  const marker = MARKERS[gloss[0]];
  return (
    <div style={{ ...styles.box, ...(large ? styles.boxLarge : null), opacity: dim ? 0.4 : 1 }}>
      <p style={large ? { ...styles.text, ...styles.textLarge } : styles.text}>{text || " "}</p>
      <div style={styles.tokens}>
        {marker && <span style={styles.marker}>{marker}</span>}
        {gloss.map((token, i) =>
          token in MARKERS ? null : (
            <span key={i} style={i === activeIndex ? { ...styles.token, ...styles.active } : styles.token}>
              {label(token)}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  box: {
    padding: "18px 32px 26px",
    textAlign: "center",
    background: "var(--navy-950, #050a14)",
    borderTop: "1px solid var(--line, rgba(56, 189, 248, 0.25))",
    color: "#fff",
    fontFamily: "var(--font, system-ui, -apple-system, 'Segoe UI', sans-serif)",
    transition: "opacity 600ms ease",
  },
  boxLarge: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: 24,
    borderTop: "none",
  },
  text: {
    margin: "0 0 14px",
    fontSize: "clamp(26px, 3.6vw, 54px)",
    fontWeight: 650,
    lineHeight: 1.2,
    textShadow: "0 2px 12px rgba(0, 0, 0, 0.8)",
  },
  textLarge: { fontSize: "clamp(36px, 6vw, 88px)" },
  tokens: { display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: 10, minHeight: 48 },
  token: {
    padding: "6px 14px",
    borderRadius: 10,
    fontSize: "clamp(18px, 2.2vw, 34px)",
    fontWeight: 700,
    letterSpacing: "0.04em",
    color: "rgba(255, 255, 255, 0.55)",
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "rgba(255, 255, 255, 0.18)",
    transition: "all 120ms ease-out",
  },
  active: {
    color: "var(--gold-ink, #1a0f00)",
    background: "var(--gold, #ffb02e)",
    borderColor: "var(--gold, #ffb02e)",
    transform: "scale(1.08)",
    boxShadow: "0 0 24px rgba(217, 180, 95, 0.5)",
  },
  marker: {
    padding: "4px 12px",
    borderRadius: 999,
    fontSize: "clamp(14px, 1.4vw, 22px)",
    color: "#7dd3fc",
    border: "1px dashed rgba(125, 211, 252, 0.6)",
  },
};
