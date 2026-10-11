"use client";
// What the guest reads at the top of the single screen: whose turn it is and, at the end of their turn,
// the sentence that was understood and is being spoken to the receptionist.
import type { CapturePhase } from "@/app/api/guest/bus";
import type { TurnPhase } from "@/lib/turns";
import styles from "./GuestTurnBanner.module.css";

type Props = {
  phase: TurnPhase;
  capture: CapturePhase | null;
  said: string | null; // last guest sentence
  staffTalking: boolean; // the mic hears the receptionist, or a sentence is being translated
  offline: boolean; // the recognizer did not answer: the guest cannot sign for now
};

export default function GuestTurnBanner({ phase, capture, said, staffTalking, offline }: Props) {
  if (phase === "speaking" && said) {
    return (
      <div className={`${styles.banner} ${styles.said}`} role="status">
        <span className={styles.label}>You said</span>
        <span className={styles.sentence}>{said}</span>
      </div>
    );
  }
  if (phase === "requesting" || phase === "guest") {
    const signing = capture === "signing";
    const processing = capture === "processing";
    return (
      <div className={`${styles.banner} ${styles.guest}`} data-signing={signing || undefined} role="status">
        <span className={styles.title}>
          {processing ? "Translating…" : signing ? "Signing…" : "Your turn"}
        </span>
        <span className={styles.hint}>
          {processing ? "One moment" : signing ? "Rest your hands to finish" : "Sign when you're ready"}
        </span>
      </div>
    );
  }
  if (staffTalking) {
    return (
      <div className={`${styles.banner} ${styles.staff}`} role="status" aria-label="The front desk is speaking">
        <span className={styles.dots} aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span>Front desk</span>
      </div>
    );
  }
  if (offline) {
    return (
      <div className={`${styles.banner} ${styles.offline}`} role="status">
        Sign recognition is offline
      </div>
    );
  }
  return null;
}
