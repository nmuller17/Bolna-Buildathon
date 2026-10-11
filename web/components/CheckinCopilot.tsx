// P4: check-in co-pilot panel for /staff. Shows which standard check-in items the guest has been given
// (signed and captioned on the guest screen) or has settled by signing, with gentle "not shared yet" hints.
// The state lives in /staff (web/lib/app/checklist.ts); this component only draws it. Nothing blocks.
import { CHECKIN_ITEMS, CHECKLIST_NOTE, notSharedBeforeGoodbye, type CheckinItemStatus } from "@/lib/app/checklist";
import styles from "./checkinCopilot.module.css";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function stateText(item: CheckinItemStatus) {
  if (item.state === "sent" && item.at !== null) return `signed to the guest · ${time(item.at)}`;
  if (item.state === "confirmed" && item.at !== null) return `the guest confirmed · ${time(item.at)}`;
  return "not shared yet";
}

export function CheckinCopilot({ items, onReset }: { items: CheckinItemStatus[]; onReset: () => void }) {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const reminders = notSharedBeforeGoodbye(items);
  return (
    <section className={styles.card} aria-labelledby="copilot-title">
      <div className={styles.head}>
        <h2 id="copilot-title" className={styles.title}>
          Check-in co-pilot
        </h2>
        <button type="button" className={styles.reset} onClick={onReset}>
          Reset checklist
        </button>
      </div>
      <p className={styles.note}>{CHECKLIST_NOTE}</p>
      <ul className={styles.list}>
        {CHECKIN_ITEMS.map((def) => {
          const item = byKey.get(def.key);
          if (!item) return null;
          return (
            <li key={def.key} className={styles.item} data-state={item.state}>
              <span className={styles.mark} data-state={item.state} aria-hidden />
              <span className={styles.body}>
                <span className={styles.label}>{def.label}</span>
                <span className={styles.state} title={item.sentence ?? undefined}>
                  {stateText(item)}
                </span>
                {item.guestAskedAt !== null && item.state === "not_shared" && (
                  <span className={styles.asked}>The guest asked at {time(item.guestAskedAt)}; not answered yet.</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {reminders.length > 0 && (
        <p className={styles.reminder} role="status">
          Before saying goodbye, not shared yet: {reminders.join(", ")}.
        </p>
      )}
    </section>
  );
}
