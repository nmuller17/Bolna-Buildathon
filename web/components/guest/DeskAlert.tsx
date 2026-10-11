"use client";
// Visual alerts from the desk (docs/features-plan.md F9). Generic codes only (no names, rooms or
// free text), full width, in the assertive live region, and never a sound. One flash unless the guest
// turned it off or the device asks for reduced motion (then a steady thick border). Vibration only
// where the browser has it and the guest left it on. No emergency code exists (strategy section 4).
import { useEffect, useRef } from "react";
import { DESK_ALERT_TEXT, type GuestDeskAlert } from "@/lib/app/types";
import s from "./guest.module.css";

export default function DeskAlert(props: { alert: GuestDeskAlert; flash: boolean; vibrate: boolean; interactive: boolean; onOk: (id: string) => void }) {
  const { alert, flash, vibrate, interactive, onOk } = props;
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (vibrate && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try {
        navigator.vibrate([250, 120, 250]);
      } catch {}
    }
    // Focus moves to OK only when the guest is not in the middle of typing.
    const el = document.activeElement;
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) okRef.current?.focus({ preventScroll: true });
  }, [alert.id, vibrate]);

  return (
    <div className={s.deskAlert} data-flash={flash || undefined} role="alert" aria-live="assertive">
      <svg aria-hidden="true" viewBox="0 0 24 24" className={s.deskAlertIcon}>
        <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <p className={s.deskAlertText}>
        <span className={s.deskAlertFrom}>From the front desk</span>
        {DESK_ALERT_TEXT[alert.code]}
      </p>
      {interactive && (
        <button ref={okRef} type="button" className={s.deskAlertOk} onClick={() => onOk(alert.id)}>
          OK
        </button>
      )}
    </div>
  );
}
