"use client";
// P4 (builder S): visual alerts from the desk to the guest screen (docs/features-plan.md F9).
// Four generic codes only: no names, rooms or free text travel in an alert, and there is deliberately
// no emergency code (a screen may be asleep; the app makes no emergency claims). The guest screen shows
// the alert full width with no sound, flashes once (a steady border under reduced motion) and vibrates
// only where the device can. Pager hardware is roadmap.
import { DESK_ALERT_TEXT, FEATURE_LIMITS, type DeskAlertCode } from "@/lib/app/types";
import { clock } from "./Panels";
import type { Desk } from "./useStaffDesk";
import s from "./staff.module.css";

const CODES: DeskAlertCode[] = ["come_to_desk", "look_at_desk", "taxi_here", "room_ready"];

export default function AlertPanel({ desk }: { desk: Desk }) {
  const { ui, staffAction } = desk;
  const active = ui.sessionState === "ACTIVE";
  const waiting = ui.deskAlerts.filter((a) => a.seenAt === null).length;
  return (
    <section className={s.alertPanel} aria-labelledby="alerts-title">
      <h3 className={s.subTitle} id="alerts-title">
        Alert the guest screen <span className={s.hint}>(no sound, generic words only)</span>
      </h3>
      <div className={s.alertGrid} role="group" aria-labelledby="alerts-title">
        {CODES.map((code) => (
          <button key={code} type="button" className={s.quick} disabled={!active || waiting >= FEATURE_LIMITS.alertsOpenMax} onClick={() => void staffAction({ type: "send_alert", code })}>
            {DESK_ALERT_TEXT[code]}
          </button>
        ))}
      </div>
      {ui.deskAlerts.length > 0 && (
        <ul className={s.alertList} aria-live="polite">
          {ui.deskAlerts.map((a) => (
            <li key={a.id}>
              <span>
                &ldquo;{DESK_ALERT_TEXT[a.code]}&rdquo; sent {clock(a.sentAt, true)}: <strong>{a.seenAt ? `Seen ${clock(a.seenAt, true)}` : "Waiting for the guest"}</strong>
              </span>
              <button type="button" className={s.linkBtn} onClick={() => void staffAction({ type: "cancel_alert", id: a.id })}>
                Clear
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className={s.hint}>
        Not for emergencies: go to the guest. The guest screen vibrates only where the device can (iPads and laptops cannot vibrate). At most {FEATURE_LIMITS.alertsOpenMax} waiting, {FEATURE_LIMITS.alertsPerMinute} a minute.
      </p>
    </section>
  );
}
