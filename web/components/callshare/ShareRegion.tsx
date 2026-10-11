"use client";
// Call-share view (P4): the 16:9 area the receptionist shares into the video call. Bellhop avatar (P2's
// mountAvatar), big captions (AvatarCaptions), an "AI avatar" label, a status line and the consent notice.
// Everything inside this box is what the remote guest sees; nothing outside it is shared.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import AvatarCaptions from "@/components/AvatarCaptions";
import { mountAvatar } from "@/lib/avatar/player";

export type ShareStatus = "waiting" | "signing" | "captions" | "your-turn";

export type ShareState = {
  text: string;
  gloss: string[];
  active: number | null;
  status: ShareStatus;
  consent: boolean;
};

export const INITIAL_SHARE_STATE: ShareState = { text: "", gloss: [], active: null, status: "waiting", consent: true };

const STATUS_TEXT: Record<ShareStatus, string> = {
  waiting: "Waiting for the front desk",
  signing: "Signing",
  captions: "Captions only for this message",
  "your-turn": "Your turn: sign to your camera, or type in the chat",
};

export default function ShareRegion({ state }: { state: ShareState }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [webgl, setWebgl] = useState(true);

  useEffect(() => {
    const mount = mountAvatar(stageRef.current!, { style: "bellhop" });
    setWebgl(mount.webgl);
    return () => mount.unmount();
  }, []);

  const idle = state.status === "waiting" && state.gloss.length === 0 && !state.text;

  return (
    <section style={styles.region} aria-label="Shared to the guest">
      <div style={styles.top}>
        <span style={styles.label}>
          <b style={styles.brand}>SignBridge</b> — signing by an AI avatar, captions shown
        </span>
        <span style={state.status === "signing" ? { ...styles.status, ...styles.statusLive } : styles.status}>
          {state.status === "signing" && <i style={styles.liveDot} className="cs-pulse" />}
          {STATUS_TEXT[state.status]}
          {state.status === "waiting" && <span className="cs-dots" aria-hidden="true" />}
        </span>
      </div>

      <div ref={stageRef} style={{ ...styles.stage, display: webgl ? "block" : "none" }} />

      {idle ? (
        <div style={styles.idleBox}>
          <p style={styles.idleText}>The front desk will sign to you here, with English captions.</p>
        </div>
      ) : (
        <AvatarCaptions text={state.text} gloss={state.gloss} activeIndex={state.active} large={!webgl} />
      )}

      {state.consent && (
        <div style={styles.consentWrap}>
          <div style={styles.consent} role="note">
            <h2 style={styles.consentTitle}>Before we start</h2>
            <ul style={styles.consentList}>
              <li>The front desk is using <b>SignBridge</b> in this call. It is an AI tool, not a human interpreter, and it can make mistakes.</li>
              <li>An AI avatar signs what the front desk says, with English captions.</li>
              <li>To answer, sign to your camera as usual. A program on the hotel&apos;s laptop reads your signs from this call&apos;s video and turns them into English for the front desk.</li>
              <li>Nothing is recorded or saved. Your video does not go anywhere new.</li>
              <li>Prefer not to? Say so in the chat and we will use text chat instead.</li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  region: {
    position: "relative",
    aspectRatio: "16 / 9",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "#050a14",
    color: "#fff",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    containerType: "inline-size",
  },
  top: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    padding: "1.6cqw 2cqw",
    pointerEvents: "none",
  },
  label: {
    padding: "0.5cqw 1.1cqw",
    borderRadius: 999,
    background: "rgba(5, 10, 20, 0.78)",
    border: "1px solid rgba(255, 255, 255, 0.28)",
    fontSize: "clamp(11px, 1.35cqw, 20px)",
    color: "#e2e8f0",
  },
  brand: { color: "#ffb02e", fontWeight: 750 },
  status: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.6cqw",
    padding: "0.5cqw 1.1cqw",
    borderRadius: 999,
    background: "rgba(5, 10, 20, 0.78)",
    border: "1px solid rgba(125, 211, 252, 0.45)",
    fontSize: "clamp(11px, 1.35cqw, 20px)",
    fontWeight: 600,
    color: "#bae6fd",
  },
  statusLive: { borderColor: "#ffb02e", color: "#ffd48a" },
  liveDot: { width: "0.8cqw", height: "0.8cqw", minWidth: 7, minHeight: 7, borderRadius: "50%", background: "#ffb02e" },
  stage: { position: "relative", flex: 1, minHeight: 0, overflow: "hidden" },
  idleBox: {
    padding: "2cqw 3cqw 2.6cqw",
    textAlign: "center",
    background: "#050a14",
    borderTop: "1px solid rgba(56, 189, 248, 0.25)",
  },
  idleText: { margin: 0, fontSize: "clamp(16px, 2.6cqw, 40px)", fontWeight: 600, color: "rgba(255, 255, 255, 0.82)" },
  consentWrap: {
    position: "absolute",
    inset: 0,
    zIndex: 3,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "4cqw",
    background: "rgba(3, 6, 12, 0.72)",
  },
  consent: {
    maxWidth: "78cqw",
    padding: "2.4cqw 3.2cqw",
    borderRadius: "1.4cqw",
    background: "#0b1426",
    border: "2px solid #ffb02e",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.6)",
  },
  consentTitle: { margin: "0 0 1.2cqw", fontSize: "clamp(18px, 3cqw, 46px)", color: "#ffb02e" },
  consentList: {
    margin: 0,
    paddingLeft: "1.2em",
    display: "grid",
    gap: "0.8cqw",
    fontSize: "clamp(13px, 1.9cqw, 29px)",
    lineHeight: 1.3,
    color: "#f1f5f9",
  },
};
