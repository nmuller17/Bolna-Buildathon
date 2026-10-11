"use client";
// Live captions of the receptionist's speech (docs/features-plan.md F3), word by word.
//
// - The badge always names the speech-to-text that made them, word for word from CAPTION_BACKEND_LABEL
//   ("On this laptop", "Cloud: ...", "Typed"), so a cloud path is never shown as local.
// - Unsure words are grey with a dotted underline; LIVE_CAPTION_NOTE explains them.
// - Finished lines go into a polite live region (role="log"); the line still being spoken is not
//   announced, so a screen reader or braille display is not flooded with revisions.
// - Live captions never drive the avatar (only exact fixed sentences do) and never become fact tiles.
// - Every string is rendered as text.
import { useEffect, useRef } from "react";
import {
  CAPTION_BACKEND_IS_CLOUD,
  CAPTION_BACKEND_LABEL,
  CLOUD_CAPTION_GUEST_NOTE,
  LIVE_CAPTION_NOTE,
  LOCAL_CAPTION_GUEST_NOTE,
  type CaptionBackend,
  type GuestLiveCaption,
} from "@/lib/app/types";
import s from "./guest.module.css";

function BackendIcon({ backend }: { backend: CaptionBackend }) {
  const d =
    backend === "local"
      ? "M4 6h16v10H4zM2 19h20" // laptop
      : backend === "typed"
        ? "M3 7h18v10H3zM6 10h1m3 0h1m3 0h1m3 0h1M7 14h10" // keyboard
        : "M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 9.3 4.4 4.4 0 0 0 7 18z"; // cloud
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={s.badgeIcon}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Words({ c }: { c: GuestLiveCaption }) {
  if (c.words.length === 0) return <>{c.text}</>;
  return (
    <>
      {c.words.map((w, i) => (
        <span key={i} className={w.unsure ? s.unsureWord : undefined}>
          {i > 0 ? " " : ""}
          {w.w}
        </span>
      ))}
    </>
  );
}

export default function LiveCaptions({ captions, backend }: { captions: GuestLiveCaption[]; backend: CaptionBackend | null }) {
  const listRef = useRef<HTMLOListElement>(null);
  const finals = captions.filter((c) => c.final || c.retracted);
  const speaking = captions.filter((c) => !c.final && !c.retracted).at(-1) ?? null;
  const cloud = backend ? CAPTION_BACKEND_IS_CLOUD[backend] : false;

  // Keep the newest line in view inside the scroll box (not the page).
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [captions]);

  if (!backend && captions.length === 0) return null;

  return (
    <section className={s.live} aria-labelledby="live-title" data-cloud={cloud || undefined}>
      <div className={s.liveHead}>
        <h3 id="live-title" className={s.subTitle}>
          Live captions
        </h3>
        {backend && (
          <p className={s.badge} data-backend={backend}>
            <BackendIcon backend={backend} />
            <span>
              <span className="sr-only">Captions made: </span>
              {CAPTION_BACKEND_LABEL[backend]}
            </span>
          </p>
        )}
      </div>
      {backend === "local" && <p className={s.small}>{LOCAL_CAPTION_GUEST_NOTE}</p>}
      {cloud && <p className={s.cloudNote}>{CLOUD_CAPTION_GUEST_NOTE}</p>}
      {backend === "typed" && captions.length === 0 && <p className={s.small}>Live captions are off. The desk types or uses set sentences.</p>}

      {finals.length > 0 && (
        <ol ref={listRef} className={s.liveList} role="log" aria-live="polite" aria-relevant="additions text" aria-label="Captions of the desk's speech">
          {finals.map((c) => (
            <li key={c.utteranceId} className={s.liveLine} data-retracted={c.retracted || undefined}>
              {c.retracted ? (
                <>
                  <del className={s.liveRemoved}>{c.text}</del>
                  <span className={s.liveRemovedNote}>Removed by the desk</span>
                </>
              ) : (
                <Words c={c} />
              )}
            </li>
          ))}
        </ol>
      )}
      {speaking && (
        <p className={s.liveNow}>
          <span className={s.liveDot} aria-hidden="true" />
          <span>
            <Words c={speaking} />
          </span>
        </p>
      )}
      {captions.length > 0 && <p className={s.small}>{LIVE_CAPTION_NOTE}</p>}
    </section>
  );
}
