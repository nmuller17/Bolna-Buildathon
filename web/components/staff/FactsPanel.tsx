"use client";
// P4 (builder S): facts on the guest screen, never said aloud (docs/features-plan.md F1, F4).
// Staff type each value (or show the hotel's value from SB_PROPERTY_FACTS); nothing here comes from
// speech recognition. The room number and the Wi-Fi password are never spoken, never sent to a vendor
// and never written to a log line: the staff screen suggests saying "Your room number is on your
// screen" instead of saying it in the lobby. The guest keeps the values on their own take-home card.
import { useState } from "react";
import { FACT_KEYS, FACT_LABEL, FACT_SENSITIVE, FEATURE_LIMITS, type FactKey } from "@/lib/app/types";
import type { Desk } from "./useStaffDesk";
import s from "./staff.module.css";

export default function FactsPanel({ desk }: { desk: Desk }) {
  const { ui, staffAction } = desk;
  const active = ui.sessionState === "ACTIVE";
  const shown = new Map(ui.facts.facts.map((f) => [f.key, f]));
  const [draft, setDraft] = useState<Partial<Record<FactKey, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<FactKey, string>>>({});
  const [resent, setResent] = useState<string | null>(null);

  const show = async (key: FactKey) => {
    const value = (draft[key] ?? shown.get(key)?.value ?? ui.facts.property[key] ?? "").trim();
    const res = await staffAction({ type: "set_fact", key, value });
    if (res && !res.ok) setErrors((e) => ({ ...e, [key]: res.message }));
    else {
      setErrors((e) => ({ ...e, [key]: undefined }));
      setDraft((d) => ({ ...d, [key]: undefined }));
    }
  };

  return (
    <section className={s.factsPanel} aria-labelledby="facts-title">
      <h3 className={s.subTitle} id="facts-title">
        Facts on the guest screen <span className={s.hint}>(shown, not said aloud; the guest can take them home)</span>
      </h3>
      {shown.has("room") && (
        <p className={s.factHint} role="status">
          Say: &ldquo;Your room number is on your screen.&rdquo; Do not say it aloud in the lobby.
        </p>
      )}
      <ul className={s.factList}>
        {FACT_KEYS.map((key) => {
          const cur = shown.get(key);
          const value = draft[key] ?? cur?.value ?? ui.facts.property[key] ?? "";
          const id = `fact-${key}`;
          return (
            <li key={key} className={s.factRow} data-shown={cur ? true : undefined}>
              <label htmlFor={id}>
                {FACT_LABEL[key]}
                {FACT_SENSITIVE[key] && <span className={s.factPrivate}> private</span>}
              </label>
              <input
                id={id}
                className={s.input}
                maxLength={FEATURE_LIMITS.factValueMax}
                value={value}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={errors[key] ? true : undefined}
                aria-describedby={errors[key] ? `${id}-err` : undefined}
                onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && value.trim()) void show(key);
                }}
              />
              <button type="button" className={s.small} disabled={!active || !value.trim()} onClick={() => void show(key)}>
                {cur && cur.value === value.trim() ? "Shown" : "Show"}
              </button>
              {cur && (
                <button type="button" className={s.linkBtn} disabled={!active} onClick={() => void staffAction({ type: "clear_fact", key })}>
                  Remove
                </button>
              )}
              {errors[key] && (
                <span id={`${id}-err`} className={s.fieldError}>
                  {errors[key]}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className={s.row}>
        <button
          type="button"
          className={s.secondary}
          disabled={!active || shown.size === 0}
          onClick={async () => {
            const res = await staffAction({ type: "resend_facts" });
            setResent(res && res.ok ? "Sent again." : null);
          }}
        >
          Send the facts again
        </button>
        <span className={s.hint}>{resent ?? "After the guest window reconnects, the tiles come back only when you press this."}</span>
      </div>
    </section>
  );
}
