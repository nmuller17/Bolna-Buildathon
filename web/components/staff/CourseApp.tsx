"use client";
// P4 (builder S): the staff micro-course (docs/features-plan.md F14). The 20 hotel sentences from
// docs/vocabulary.md section 1, each played by the computer avatar with its exact English caption and its
// sign key. Without WebGL the sign key tags are shown instead. It says plainly that this is a computer
// avatar and that signing is learnt from a Deaf teacher. No data about anyone is used or kept.
import { useState } from "react";
import { KeyTag } from "@/components/app/KeyTag";
import AvatarStage from "@/components/guest/AvatarStage";
import { STAFF_INTENTS } from "@/lib/app/vocab";
import type { GuestStaffUtterance } from "@/lib/app/types";
import s from "./staff.module.css";

export default function CourseApp() {
  const [current, setCurrent] = useState<{ caption: GuestStaffUtterance; key: number } | null>(null);
  const play = (i: number) => {
    const it = STAFF_INTENTS[i];
    setCurrent((c) => ({
      caption: { type: "staff_utterance", id: `course-${it.key}`, text: it.text, gloss: [...it.gloss], glossSource: "fixed_intent", captionSource: "quick_reply" },
      key: (c?.key ?? 0) + 1,
    }));
  };
  return (
    <main className={`${s.root} ${s.course}`}>
      <header className={s.courseHeader}>
        <p className={s.brandLine}>
          SignBridge <span>staff micro-course</span>
        </p>
        <h1 className={s.courseTitle}>The 20 hotel sentences in sign</h1>
        <p className={s.courseNote}>Computer avatar. Learn signing from a Deaf teacher. This page shows what the guest screen shows for each quick reply.</p>
        <a className={s.linkBtn} href="/staff">
          Back to the desk
        </a>
      </header>
      <div className={s.courseGrid}>
        <ol className={s.courseList}>
          {STAFF_INTENTS.map((it, i) => (
            <li key={it.key}>
              <button type="button" className={s.courseItem} aria-current={current?.caption.id === `course-${it.key}` || undefined} onClick={() => play(i)}>
                <span className={s.courseText}>{it.text}</span>
                <span className={s.tagLine} aria-label={`Signs: ${it.gloss.join(" ")}`}>
                  {it.gloss.map((t, k) => (
                    <KeyTag key={k} token={t} small />
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ol>
        <section className={s.courseStage} aria-live="polite" aria-label="Avatar">
          {current ? (
            <>
              <p className={s.courseCaption}>{current.caption.text}</p>
              <AvatarStage caption={current.caption} playKey={current.key} showAvatar interactive />
              <button type="button" className={s.secondary} onClick={() => setCurrent((c) => (c ? { ...c, key: c.key + 1 } : c))}>
                Play again
              </button>
            </>
          ) : (
            <p className={s.hint}>Pick a sentence to watch it signed.</p>
          )}
        </section>
      </div>
    </main>
  );
}
