"use client";
// Call-share view (P4, Option A): SignBridge inside any video call (Zoom, Teams, Meet, FaceTime) with no platform API.
// Left: the 16:9 area shared to the remote Deaf guest (bellhop avatar + captions). Right: front-desk controls,
// never shared. Optional pop-out window (/call-share/window) holds only the shared area, for "share a window".
// No network calls besides the local sign files and avatar model; no API keys; typed text is not logged or stored.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { INTENTS, captionsOnly, fromIntent, matchTyped, type Utterance } from "@/components/callshare/intents";
import CallShareStyles from "@/components/callshare/CallShareStyles";
import ShareRegion from "@/components/callshare/ShareRegion";
import { useCallShare } from "@/components/callshare/useCallShare";

/** The consent notice stays up at least this long, so the guest can read it before the front desk hides it. */
const MIN_NOTICE_SEC = 10;

export default function CallSharePage() {
  const { state, say, setConsent } = useCallShare("controller");
  const [typed, setTyped] = useState("");
  const [spell, setSpell] = useState(true);
  const [last, setLast] = useState<Utterance | null>(null);
  const [pending, setPending] = useState<Utterance | null>(null); // a closest phrase waiting for its second tap
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [noticeLeft, setNoticeLeft] = useState(MIN_NOTICE_SEC);
  const regionRef = useRef<HTMLDivElement>(null);

  const preview = matchTyped(typed, spell);
  const locked = state.consent; // nothing is sent while the guest is reading the notice

  // Count down the notice's minimum reading time each time it is shown.
  useEffect(() => {
    if (!state.consent) return;
    const shown = Date.now();
    setNoticeLeft(MIN_NOTICE_SEC);
    const t = setInterval(() => {
      const left = Math.max(0, MIN_NOTICE_SEC - Math.floor((Date.now() - shown) / 1000));
      setNoticeLeft(left);
      if (left === 0) clearInterval(t);
    }, 250);
    return () => clearInterval(t);
  }, [state.consent]);

  useEffect(() => {
    const el = regionRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function send(u: Utterance) {
    if (locked) return; // the notice is closed only by "Guest agreed", never by a message
    setLast(u);
    setPending(null);
    say(u.text, u.gloss);
  }

  function submitTyped() {
    if (!preview || locked) return;
    if (preview.confirm && !pending) {
      setPending(preview); // first tap: show the phrase the guest would get, ask again
      return;
    }
    send(pending ?? preview);
    setTyped("");
  }

  function popOut() {
    window.open("/call-share/window", "signbridge-share", "popup,width=1280,height=720");
  }

  return (
    <main style={styles.page}>
      <CallShareStyles />
      <div style={styles.left}>
        <div style={styles.shareHead}>
          <span style={styles.shareTag}>SHARED TO THE GUEST</span>
          <span style={styles.shareSize}>{size ? `${size.w} × ${size.h} px` : ""}</span>
        </div>
        <div ref={regionRef} style={styles.regionBox}>
          <ShareRegion state={state} />
        </div>
        <div style={styles.help}>
          <h2 style={styles.h2}>How to share into the call</h2>
          <ol style={styles.steps}>
            <li>
              <b>Zoom, part of the screen:</b> Share Screen → Advanced → Portion of Screen. Drag the green frame onto
              the dashed outline above ({size ? `${size.w} × ${size.h} px` : "16:9"}).
            </li>
            <li>
              <b>Any app, one window:</b>{" "}
              <button type="button" style={styles.link} onClick={popOut}>
                Open the share window
              </button>{" "}
              (only the avatar and captions, kept in step with this page). In Zoom, Teams, Meet or FaceTime, share that
              window and keep this page for the buttons.
            </li>
            <li>
              <b>As a camera (optional):</b> in OBS, add a Window Capture of the share window, click Start Virtual
              Camera, then pick &quot;OBS Virtual Camera&quot; as the camera in the call. OBS is not installed here.
            </li>
            <li>
              <b>The guest&apos;s replies:</b> SignBridge reads the guest&apos;s video tile from this laptop&apos;s screen
              (live.py --source screen). Keep the guest&apos;s tile large and visible.
            </li>
          </ol>
          <p style={styles.privacy}>
            Privacy: everything runs on this laptop. No recording, no saving, no Zoom or Teams API, no keys, no inbound
            connections. Typed text is not logged. Start the sign reader (live.py --source screen) only after the guest
            has agreed to the notice.
          </p>
        </div>
      </div>

      <aside style={styles.panel} aria-label="Front desk controls (not shared)">
        <header style={styles.panelHead}>
          <h1 style={styles.h1}>Front desk controls</h1>
          <p style={styles.sub}>Not shared. Only the area on the left goes into the call.</p>
        </header>

        <div style={styles.row}>
          <button
            type="button"
            style={state.consent ? { ...styles.primary, ...(noticeLeft > 0 ? styles.off : {}) } : styles.ghost}
            disabled={state.consent && noticeLeft > 0}
            onClick={() => setConsent(!state.consent)}
          >
            {state.consent
              ? noticeLeft > 0
                ? `Guest is reading (${noticeLeft} s)`
                : "Guest agreed: hide notice"
              : "Show notice"}
          </button>
          <button type="button" style={styles.ghost} disabled={!last || locked} onClick={() => last && send(last)}>
            Replay
          </button>
        </div>
        {locked && (
          <p style={styles.lockNote}>
            The guest sees the notice. Ask them (in the chat or by signing) whether they agree, then tap
            &quot;Guest agreed&quot;. Messages are sent only after that. If they say no, use the call&apos;s text chat.
          </p>
        )}

        <h2 style={styles.h2}>One tap</h2>
        <div style={styles.grid}>
          {INTENTS.map((intent) => (
            <button
              key={intent.id}
              type="button"
              disabled={locked}
              title={`${intent.text}  —  ${intent.gloss}`}
              style={{
                ...styles.intent,
                ...(last?.intent === intent.id ? styles.intentOn : {}),
                ...(locked ? styles.off : {}),
              }}
              onClick={() => send(fromIntent(intent))}
            >
              <span style={styles.num}>{intent.id}</span>
              {intent.short}
            </button>
          ))}
        </div>

        <h2 style={styles.h2}>Type it</h2>
        <form
          style={styles.typeForm}
          onSubmit={(e) => {
            e.preventDefault();
            submitTyped();
          }}
        >
          <div style={styles.row}>
            <input
              style={styles.input}
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                setPending(null);
              }}
              placeholder="e.g. your room is 518"
              autoComplete="off"
              spellCheck={false}
              aria-label="Type a message for the guest"
            />
            <button type="submit" style={styles.primary} disabled={!preview || locked}>
              {pending ? "Confirm" : "Send"}
            </button>
          </div>
          {pending ? (
            <div style={styles.confirmBox} role="alert">
              <p style={styles.confirmText}>
                The guest will see <b>&quot;{pending.text}&quot;</b>, not your exact words. Tap Confirm to send it.
              </p>
              <button
                type="button"
                style={styles.ghost}
                onClick={() => {
                  send(captionsOnly(typed, "Your words"));
                  setTyped("");
                }}
              >
                Send my words instead (captions only)
              </button>
            </div>
          ) : (
            <p style={preview?.intent ? styles.matchOk : styles.matchNo}>
              {preview
                ? `${preview.note}${preview.gloss.length ? `  →  ${preview.gloss.join(" ")}` : ""}`
                : "Matched to the closest of the 20 phrases by keywords. Negations (not, closed...) and numbers the phrase lacks are sent as your own words, captions only."}
            </p>
          )}
          <label style={styles.check}>
            <input type="checkbox" checked={spell} onChange={(e) => setSpell(e.target.checked)} />
            Fingerspell a short unmatched word (a name, a code)
          </label>
        </form>

      </aside>
    </main>
  );
}

const PANEL_W = 360;
const GAP = 20;
const HEAD_H = 26;

const styles: Record<string, CSSProperties> = {
  page: {
    position: "fixed",
    inset: 0,
    display: "flex",
    gap: GAP,
    padding: GAP,
    background: "#0e1117",
    color: "#e5e7eb",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    overflow: "hidden",
  },
  // Padding keeps the dashed outline (drawn outside the shared area) from being clipped by the scroll box.
  left: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, padding: 8, margin: -8, overflowY: "auto" },
  shareHead: {
    height: HEAD_H - 6,
    width: `min(100%, calc((100vh - ${2 * GAP + HEAD_H}px) * 16 / 9))`,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 12,
    letterSpacing: "0.08em",
  },
  shareTag: { color: "#ffb02e", fontWeight: 700 },
  shareSize: { color: "#9ca3af", fontVariantNumeric: "tabular-nums" },
  regionBox: {
    width: `min(100%, calc((100vh - ${2 * GAP + HEAD_H}px) * 16 / 9))`,
    outline: "2px dashed rgba(255, 176, 46, 0.85)",
    outlineOffset: 4,
  },
  panel: {
    width: PANEL_W,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 16,
    borderRadius: 14,
    background: "#161b24",
    border: "1px solid #262d3a",
    overflowY: "auto",
    alignSelf: "flex-start",
    maxHeight: "100%",
    boxSizing: "border-box",
  },
  panelHead: { display: "flex", flexDirection: "column", gap: 2 },
  h1: { margin: 0, fontSize: 18, fontWeight: 700, color: "#f9fafb" },
  sub: { margin: 0, fontSize: 12.5, color: "#9ca3af" },
  h2: { margin: "6px 0 0", fontSize: 11.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9ca3af" },
  row: { display: "flex", gap: 8 },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
  intent: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "7px 8px",
    borderRadius: 8,
    border: "1px solid #2c3442",
    background: "#1d2330",
    color: "#e5e7eb",
    fontSize: 13,
    textAlign: "left",
    cursor: "pointer",
    lineHeight: 1.15,
  },
  intentOn: { borderColor: "#ffb02e", background: "#2a2210", color: "#ffe2a8" },
  num: {
    flexShrink: 0,
    width: 20,
    height: 20,
    display: "inline-grid",
    placeItems: "center",
    borderRadius: 5,
    background: "#0e1117",
    color: "#9ca3af",
    fontSize: 11,
    fontVariantNumeric: "tabular-nums",
  },
  primary: {
    flex: 1,
    padding: "9px 14px",
    borderRadius: 8,
    border: "none",
    background: "#ffb02e",
    color: "#1a0f00",
    fontWeight: 700,
    fontSize: 14,
    cursor: "pointer",
  },
  ghost: {
    flex: 1,
    padding: "9px 14px",
    borderRadius: 8,
    border: "1px solid #3a4352",
    background: "transparent",
    color: "#e5e7eb",
    fontWeight: 600,
    fontSize: 14,
    cursor: "pointer",
  },
  typeForm: { display: "flex", flexDirection: "column", gap: 6 },
  input: {
    flex: 3,
    minWidth: 0,
    padding: "9px 10px",
    borderRadius: 8,
    border: "1px solid #3a4352",
    background: "#0e1117",
    color: "#f9fafb",
    fontSize: 14,
  },
  matchOk: { margin: 0, fontSize: 12, color: "#86efac", minHeight: 32, lineHeight: 1.35 },
  matchNo: { margin: 0, fontSize: 12, color: "#9ca3af", minHeight: 32, lineHeight: 1.35 },
  check: { display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "#cbd5e1" },
  off: { opacity: 0.45, cursor: "not-allowed" },
  lockNote: { margin: 0, fontSize: 12, lineHeight: 1.4, color: "#ffd48a" },
  confirmBox: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid #ffb02e",
    background: "#2a2210",
  },
  confirmText: { margin: 0, fontSize: 12.5, lineHeight: 1.4, color: "#ffe2a8" },
  help: {
    width: `min(100%, calc((100vh - ${2 * GAP + HEAD_H}px) * 16 / 9))`,
    marginTop: 14,
    padding: "12px 16px",
    borderRadius: 12,
    background: "#161b24",
    border: "1px solid #262d3a",
    boxSizing: "border-box",
  },
  steps: {
    margin: "8px 0 8px",
    paddingLeft: 18,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    columnGap: 28,
    rowGap: 8,
    fontSize: 12.5,
    lineHeight: 1.45,
    color: "#cbd5e1",
  },
  link: {
    padding: 0,
    border: "none",
    background: "none",
    color: "#7dd3fc",
    textDecoration: "underline",
    font: "inherit",
    cursor: "pointer",
  },
  privacy: { margin: 0, fontSize: 12, lineHeight: 1.45, color: "#86efac" },
};
