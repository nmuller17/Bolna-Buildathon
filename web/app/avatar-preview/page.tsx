"use client";
// Avatar test page (P2 + P4): play HELLO or any gloss, loop, FPS counter in dev.
import { useEffect, useRef, useState } from "react";
import AvatarCaptions from "@/components/AvatarCaptions";
import { getAvatarFps, mountAvatar, playGloss } from "@/lib/avatar/player";

// Intents from docs/vocabulary.md whose signs are already recorded.
const PRESETS = [
  { text: "Hello!", gloss: "HELLO" },
  { text: "Welcome!", gloss: "HELLO WELCOME" },
  { text: "Do you have a reservation?", gloss: "BROWS-UP YOU HAVE RESERVATION" },
  { text: "What's your name?", gloss: "BROWS-DOWN YOUR NAME WHAT" },
  { text: "Can I see your ID?", gloss: "FS:ID SHOW PLEASE" },
];

const SHOW_FPS = process.env.NODE_ENV !== "production";

export default function AvatarPreviewPage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [webgl, setWebgl] = useState(true);
  const [glossInput, setGlossInput] = useState("BROWS-UP HELLO");
  const [caption, setCaption] = useState<{ text: string; gloss: string[] }>({ text: "", gloss: [] });
  const [active, setActive] = useState<number | null>(null);
  const [loop, setLoop] = useState(false);
  const [fps, setFps] = useState(0);
  const loopRef = useRef(loop);
  const playId = useRef(0);

  useEffect(() => {
    loopRef.current = loop;
  }, [loop]);

  useEffect(() => {
    const mount = mountAvatar(stageRef.current!);
    setWebgl(mount.webgl);
    return () => {
      playId.current++; // stops a running loop
      mount.unmount();
    };
  }, []);

  useEffect(() => {
    if (!SHOW_FPS) return;
    const timer = setInterval(() => setFps(getAvatarFps()), 500);
    return () => clearInterval(timer);
  }, []);

  async function play(text: string, glossText: string) {
    const gloss = glossText.trim().toUpperCase().split(/\s+/).filter(Boolean);
    if (gloss.length === 0) return;
    const id = ++playId.current;
    setCaption({ text, gloss });
    do {
      setActive(null);
      await playGloss(gloss, { onToken: (i) => playId.current === id && setActive(i) });
      if (playId.current !== id) return;
      setActive(null);
      if (loopRef.current) await new Promise((r) => setTimeout(r, 800));
    } while (loopRef.current && playId.current === id);
  }

  return (
    <main style={styles.page}>
      <div ref={stageRef} style={{ ...styles.stage, display: webgl ? "block" : "none" }} />
      <AvatarCaptions text={caption.text} gloss={caption.gloss} activeIndex={active} large={!webgl} />

      <form
        style={styles.panel}
        onSubmit={(e) => {
          e.preventDefault();
          play("", glossInput);
        }}
      >
        <button type="button" style={styles.button} onClick={() => play("Hello!", "HELLO")}>
          Play HELLO
        </button>
        <div style={styles.row}>
          <input
            style={styles.input}
            value={glossInput}
            onChange={(e) => setGlossInput(e.target.value)}
            placeholder="BROWS-UP HELLO"
            spellCheck={false}
          />
          <button type="submit" style={styles.button}>
            Play
          </button>
        </div>
        <label style={styles.check}>
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop
        </label>
        <div style={styles.presets}>
          {PRESETS.map((p) => (
            <button key={p.gloss} type="button" style={styles.preset} onClick={() => play(p.text, p.gloss)}>
              {p.text}
            </button>
          ))}
        </div>
        {!webgl && <p style={styles.warn}>WebGL unavailable: captions only.</p>}
      </form>

      {SHOW_FPS && webgl && <div style={styles.fps}>{fps} fps</div>}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    position: "fixed",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    background: "#050a14",
    color: "#e2f3ff",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  },
  stage: { position: "relative", flex: 1, minHeight: 0, overflow: "hidden" },
  panel: {
    position: "absolute",
    top: 12,
    left: 12,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    width: 300,
    padding: 12,
    borderRadius: 12,
    background: "rgba(8, 20, 40, 0.75)",
    border: "1px solid rgba(56, 189, 248, 0.25)",
    fontSize: 13,
  },
  row: { display: "flex", gap: 6 },
  input: {
    flex: 1,
    minWidth: 0,
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid rgba(125, 211, 252, 0.4)",
    background: "#0b1a30",
    color: "#fff",
    fontFamily: "ui-monospace, Consolas, monospace",
  },
  button: {
    padding: "6px 12px",
    borderRadius: 6,
    border: "none",
    background: "#38bdf8",
    color: "#04111f",
    fontWeight: 700,
    cursor: "pointer",
  },
  check: { display: "flex", alignItems: "center", gap: 6 },
  presets: { display: "flex", flexWrap: "wrap", gap: 4 },
  preset: {
    padding: "3px 8px",
    borderRadius: 999,
    border: "1px solid rgba(125, 211, 252, 0.4)",
    background: "transparent",
    color: "#bae6fd",
    cursor: "pointer",
    fontSize: 12,
  },
  warn: { margin: 0, color: "#fca5a5" },
  fps: {
    position: "absolute",
    top: 12,
    right: 12,
    padding: "2px 8px",
    borderRadius: 6,
    background: "rgba(0, 0, 0, 0.5)",
    fontFamily: "ui-monospace, Consolas, monospace",
    fontSize: 12,
  },
};
