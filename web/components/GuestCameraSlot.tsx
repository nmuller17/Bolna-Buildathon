"use client";
// The guest's live camera feed, always visible at the bottom right of the screen. The picture comes from the
// recognizer (recognition/live_key.py serves a mirrored MJPEG on 127.0.0.1:8765): the browser never opens the
// camera itself. Green frame = the guest's turn, their signs are being recorded; thicker and pulsing while
// they sign.
import { useEffect, useState } from "react";
import styles from "./GuestCameraSlot.module.css";

export const RECOGNIZER_URL = "http://127.0.0.1:8765";
const HEALTH_EVERY_MS = 2000;

export type CameraState = "idle" | "recording" | "signing";

export default function GuestCameraSlot({ state }: { state: CameraState }) {
  const [online, setOnline] = useState<boolean | null>(null); // null = not checked yet
  const [streamKey, setStreamKey] = useState(0); // bumped to reconnect the MJPEG after the recognizer restarts

  useEffect(() => {
    let alive = true;
    let wasOnline: boolean | null = null;
    const check = async () => {
      let ok = false;
      try {
        const res = await fetch(`${RECOGNIZER_URL}/health`, { cache: "no-store", signal: AbortSignal.timeout(1500) });
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (!alive) return;
      if (ok && wasOnline === false) setStreamKey((k) => k + 1);
      wasOnline = ok;
      setOnline(ok);
    };
    void check();
    const timer = setInterval(check, HEALTH_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className={styles.slot} data-state={state} aria-label="Your camera">
      {online ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={streamKey} className={styles.feed} src={`${RECOGNIZER_URL}/preview.mjpg?k=${streamKey}`} alt="" />
      ) : (
        <div className={styles.placeholder}>{online === null ? "Camera starting…" : "Camera offline"}</div>
      )}
      {state !== "idle" && <div className={styles.rec}>{state === "signing" ? "Recording your signs" : "Your turn"}</div>}
    </div>
  );
}
