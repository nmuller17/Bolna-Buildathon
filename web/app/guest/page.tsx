"use client";
// The guest screen (P4), both directions.
// Staff -> guest: the receptionist just talks, the bellhop signs it in ASL with karaoke captions. No buttons, no visible
// pipeline: the microphone listens all the time, each sentence is transcribed and turned into signs in the background
// (useHandsFreeSpeech), then played in order. The optional /staff console can also send sentences on the channel.
// Guest -> staff: the guest signs to the recognizer's camera window (recognition/live_key.py, next to this one); each
// recognized sign shows as a tag, then the sentence (GuestSignPanel). /staff speaks it, and this mic is muted meanwhile.
import { useCallback, useEffect, useRef, useState } from "react";
import AvatarCaptions from "@/components/AvatarCaptions";
import GuestCameraSlot from "@/components/GuestCameraSlot";
import GuestSignPanel from "@/components/GuestSignPanel";
import type { SignedSentence } from "@/components/speechToSigns";
import { useGuestEvents } from "@/components/useGuestEvents";
import { useHandsFreeSpeech } from "@/components/useHandsFreeSpeech";
import { mountAvatar, playGloss } from "@/lib/avatar/player";
import { useSignbridgeChannel, type StaffState } from "@/lib/channel";
import styles from "./guest.module.css";

const SIGN_TIMEOUT_MS_PER_TOKEN = 4000; // longest a sign (or a fingerspelled word) may take before we move on

export default function GuestPage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [webgl, setWebgl] = useState(true);
  const [caption, setCaption] = useState<SignedSentence>({ text: "", gloss: [] });
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [consoleState, setConsoleState] = useState<StaffState>("idle");
  const [staffSpeaking, setStaffSpeaking] = useState(false);
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
      try {
        // A sentence that fails or hangs (sign file missing, tab hidden) never blocks the ones after it.
        await Promise.race([
          playGloss(sentence.gloss, { onToken: (i) => mounted.current && setActiveIndex(i) }),
          new Promise((resolve) => setTimeout(resolve, SIGN_TIMEOUT_MS_PER_TOKEN * sentence.gloss.length + 6000)),
        ]);
      } catch (err) {
        console.warn(`[guest] could not sign "${sentence.text}":`, err);
      }
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

  // What the microphone heard is signed here, and shown on /staff too (staff_utterance on the channel).
  const signHeard = useCallback(
    (sentences: SignedSentence[]) => {
      for (const s of sentences) sendRef.current?.({ type: "staff_utterance", text: s.text, gloss: s.gloss });
      sign(sentences);
    },
    [sign],
  );
  const speech = useHandsFreeSpeech(signHeard, staffSpeaking);
  const guest = useGuestEvents(undefined, { onWiped: () => setCaption({ text: "", gloss: [] }) }); // staff wiped the session

  const sendRef = useRef<ReturnType<typeof useSignbridgeChannel> | null>(null);
  sendRef.current = useSignbridgeChannel((message) => {
    if (message.type === "staff_utterance") sign([{ text: message.text, gloss: message.gloss }]);
    else if (message.type === "staff_status") setConsoleState(message.state);
    else if (message.type === "voice_output") setStaffSpeaking(message.playing);
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

      <GuestSignPanel signs={guest.signs} utterance={guest.utterance} framing={guest.framing} />
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
