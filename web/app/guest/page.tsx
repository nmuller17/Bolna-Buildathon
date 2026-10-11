"use client";
// The demo screen (P4): the receptionist just talks, the bellhop signs it in ASL with karaoke captions.
// No buttons, no visible pipeline: the microphone listens all the time, each sentence is transcribed and turned into
// signs in the background (useHandsFreeSpeech), then played in order. Press F11 for fullscreen.
// The optional /staff console can still send sentences on the BroadcastChannel; they join the same queue.
import { useCallback, useEffect, useRef, useState } from "react";
import AvatarCaptions from "@/components/AvatarCaptions";
import GuestCameraSlot from "@/components/GuestCameraSlot";
import type { SignedSentence } from "@/components/speechToSigns";
import { useHandsFreeSpeech } from "@/components/useHandsFreeSpeech";
import { mountAvatar, playGloss } from "@/lib/avatar/player";
import { useSignbridgeChannel, type StaffState } from "@/lib/channel";
import styles from "./guest.module.css";

export default function GuestPage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [webgl, setWebgl] = useState(true);
  const [caption, setCaption] = useState<SignedSentence>({ text: "", gloss: [] });
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [consoleState, setConsoleState] = useState<StaffState>("idle");
  const queue = useRef<SignedSentence[]>([]);
  const draining = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const mount = mountAvatar(stageRef.current!, { style: "bellhop" });
    setWebgl(mount.webgl);
    return () => {
      mounted.current = false;
      mount.unmount();
    };
  }, []);

  // Plays queued sentences in order. playGloss resolves when the last sign is done.
  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    while (queue.current.length > 0 && mounted.current) {
      const sentence = queue.current.shift()!;
      setCaption(sentence);
      setActiveIndex(null);
      setPlaying(true);
      await playGloss(sentence.gloss, { onToken: (i) => mounted.current && setActiveIndex(i) });
      setActiveIndex(null);
    }
    setPlaying(false);
    draining.current = false;
  }, []);

  const sign = useCallback(
    (sentences: SignedSentence[]) => {
      queue.current.push(...sentences);
      void drain();
    },
    [drain],
  );

  const speech = useHandsFreeSpeech(sign);

  useSignbridgeChannel((message) => {
    if (message.type === "staff_utterance") sign([{ text: message.text, gloss: message.gloss }]);
    else if (message.type === "staff_status") setConsoleState(message.state);
    // TODO (guest -> staff): on repeat_request, ask the guest to sign again ("Could you repeat?", CLAUDE.md 7.2).
  });

  // Chrome starts audio only after a click or a key press on the page.
  useEffect(() => {
    if (speech.state !== "needs-click") return;
    const go = () => speech.resume();
    window.addEventListener("pointerdown", go);
    window.addEventListener("keydown", go);
    return () => {
      window.removeEventListener("pointerdown", go);
      window.removeEventListener("keydown", go);
    };
  }, [speech]);

  const hearing = speech.state === "hearing" || consoleState === "listening";
  const working = speech.state === "processing" || consoleState === "processing";

  return (
    <main className={styles.page} data-needs-click={speech.state === "needs-click" || undefined}>
      <div ref={stageRef} className={styles.stage} hidden={!webgl} />

      {(hearing || working) && (
        <div className={styles.status} role="status" aria-label={hearing ? "Listening" : "Translating"}>
          <span className={styles.dots} aria-hidden>
            <i />
            <i />
            <i />
          </span>
        </div>
      )}

      {speech.state === "needs-click" && <div className={styles.start}>Click anywhere to start listening</div>}
      {speech.state === "blocked" && <div className={styles.blocked}>Microphone unavailable</div>}

      <AvatarCaptions
        text={caption.text}
        gloss={caption.gloss}
        activeIndex={activeIndex}
        large={!webgl}
        dim={!playing && caption.text !== ""}
      />
      <GuestCameraSlot />
    </main>
  );
}
