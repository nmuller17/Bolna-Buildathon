// Guest -> staff, on /guest: the guest checks the sentence before anything is said aloud (confirmBeforeSpeak.ts).
// Shows the English sentence, the recognized signs as words with their confidence, and three equal buttons.
// "Fix" opens typing and up to three close known sentences; "None of these" offers typing, signing again or an
// interpreter. Fixing never asks the recognizer again, and a fixed sentence comes back here for Say it / Text only.
import { useState, type CSSProperties } from "react";
import { cleanGuestText, GUEST_TEXT_MAX, INTERPRETER_TEXT, type Chip, type GuestAction } from "./confirmBeforeSpeak";

export type ConfirmItem = {
  id: number;
  text: string; // the sentence as it stands now (recognized, or fixed by the guest)
  recognized: string; // the sentence as recognized
  chips: Chip[];
  alternatives: string[];
  done: GuestAction | null;
};

type Props = { item: ConfirmItem; onDecide: (action: GuestAction, text: string) => void; onEdit: (text: string) => void };

export default function GuestConfirm({ item, onDecide, onEdit }: Props) {
  const [fixing, setFixing] = useState(false);
  const [draft, setDraft] = useState("");
  const typed = cleanGuestText(draft);

  if (item.done) {
    const line =
      item.done === "say"
        ? `Said aloud: ${item.text}`
        : item.done === "text"
          ? `Shown to the desk as text, not said aloud: ${item.text}`
          : "Not sent. Sign again when you are ready.";
    return <p style={styles.done}>{line}</p>;
  }

  const use = (text: string) => {
    onEdit(text);
    setFixing(false);
    setDraft("");
  };

  if (fixing) {
    return (
      <div style={styles.box}>
        <form
          style={styles.row}
          onSubmit={(e) => {
            e.preventDefault();
            if (typed) use(typed);
          }}
        >
          <input
            style={styles.input}
            value={draft}
            maxLength={GUEST_TEXT_MAX}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type your sentence"
            aria-label="Type your sentence"
            autoFocus
          />
          <button type="submit" style={styles.button} disabled={!typed}>
            Use this
          </button>
        </form>
        {item.alternatives.length > 0 && (
          <div style={styles.row} role="group" aria-label="Did you mean">
            {item.alternatives.map((text) => (
              <button key={text} type="button" style={styles.pick} onClick={() => use(text)}>
                {text}
              </button>
            ))}
          </div>
        )}
        <div style={styles.row} role="group" aria-label="None of these">
          <span style={styles.label}>None of these:</span>
          <button type="button" style={styles.small} onClick={() => onDecide("cancel", "")}>
            Sign again
          </button>
          <button type="button" style={styles.small} onClick={() => use(INTERPRETER_TEXT)}>
            Ask for an interpreter
          </button>
          <button type="button" style={styles.small} onClick={() => setFixing(false)}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.box}>
      <p style={styles.sentence}>{item.text}</p>
      {item.text === item.recognized ? (
        <div style={styles.row} aria-label="Signs recognized">
          {item.chips.map((c, i) => (
            <span key={i} style={styles.chip}>
              {c.word}
              {c.conf !== null && <span style={styles.conf}> {Math.round(c.conf * 100)}%</span>}
            </span>
          ))}
        </div>
      ) : (
        <p style={styles.label}>Changed by you. Recognized: {item.recognized}</p>
      )}
      <div style={styles.row} role="group" aria-label="What should happen with this sentence">
        <button type="button" style={styles.button} onClick={() => onDecide("say", item.text)}>
          Say it
        </button>
        <button type="button" style={styles.button} onClick={() => onDecide("text", item.text)}>
          Text only
        </button>
        <button type="button" style={styles.button} onClick={() => setFixing(true)}>
          Fix
        </button>
      </div>
    </div>
  );
}

const button: CSSProperties = {
  minWidth: 150,
  padding: "12px 22px",
  borderRadius: 12,
  border: "2px solid var(--gold)",
  background: "var(--navy-800)",
  color: "var(--ink)",
  fontSize: "clamp(18px, 1.8vw, 26px)",
  fontWeight: 650,
  cursor: "pointer",
};

const styles: Record<string, CSSProperties> = {
  box: { display: "flex", flexDirection: "column", alignItems: "center", gap: 12, cursor: "auto" },
  row: { display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: 10 },
  sentence: { margin: 0, fontSize: "clamp(22px, 2.6vw, 38px)", fontWeight: 650, color: "var(--ink)" },
  chip: {
    padding: "4px 12px",
    borderRadius: 10,
    border: "1px solid var(--ok)",
    color: "var(--ink-soft)",
    fontSize: "clamp(15px, 1.4vw, 22px)",
  },
  conf: { color: "var(--ink-muted)", fontSize: "0.8em" },
  button,
  pick: { ...button, minWidth: 0, borderColor: "var(--ok)", fontWeight: 550 },
  small: { ...button, minWidth: 0, padding: "8px 16px", fontSize: "clamp(15px, 1.3vw, 20px)", borderColor: "var(--line)" },
  label: { margin: 0, color: "var(--ink-muted)", fontSize: "clamp(14px, 1.2vw, 18px)" },
  input: {
    width: "min(560px, 70vw)",
    padding: "12px 16px",
    borderRadius: 12,
    border: "2px solid var(--line)",
    background: "var(--navy-950)",
    color: "var(--ink)",
    fontSize: "clamp(18px, 1.8vw, 26px)",
  },
  done: { margin: 0, color: "var(--ink-soft)", fontSize: "clamp(18px, 2vw, 30px)" },
};
