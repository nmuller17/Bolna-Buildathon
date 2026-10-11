"use client";
// Call-share pop-out (P4): only the shared area, filling the window, for "share a window" in Zoom, Teams, Meet or
// FaceTime (or an OBS Window Capture feeding OBS Virtual Camera). Driven by /call-share through a BroadcastChannel.
import CallShareStyles from "@/components/callshare/CallShareStyles";
import ShareRegion from "@/components/callshare/ShareRegion";
import { useCallShare } from "@/components/callshare/useCallShare";

export default function CallShareWindowPage() {
  const { state } = useCallShare("window");
  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#050a14",
      }}
    >
      <CallShareStyles />
      <div style={{ width: "min(100vw, calc(100vh * 16 / 9))" }}>
        <ShareRegion state={state} />
      </div>
    </main>
  );
}
