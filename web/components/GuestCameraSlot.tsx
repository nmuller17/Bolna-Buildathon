// P4: small camera box (webcam + landmarks) at the bottom right of /guest, for the guest -> staff direction.
// Off until the recognition model (P3) is trained and wired: renders nothing for now.
import type { CSSProperties } from "react";

export const SHOW_GUEST_CAMERA = false;

export default function GuestCameraSlot() {
  if (!SHOW_GUEST_CAMERA) return null;
  // TODO (guest -> staff): webcam preview with landmarks (web/lib/recognition), segmenter, /predict, then guest_utterance.
  return <div style={style} aria-hidden />;
}

const style: CSSProperties = {
  position: "absolute",
  right: 24,
  bottom: 24,
  width: 240,
  aspectRatio: "4 / 3",
  borderRadius: 14,
  border: "1px solid var(--line)",
  background: "rgba(10, 20, 40, 0.7)",
};
