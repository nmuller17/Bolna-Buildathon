"use client";
// Facts on screen, never said aloud (docs/features-plan.md F1), and the take-home card (F4).
//
// Tiles come only from "fact" events: values staff typed or the hotel's own settings, never speech
// recognition. Room and Wi-Fi password are marked "Not said aloud": the app never voices them.
// The card is drawn on this screen after the guest taps "Show my card": the text, and a QR code that
// holds the same text (not a link), built in the browser from numbers (lib/app/qr.ts). Nothing is
// fetched, stored or sent while it is drawn; it is erased with the conversation.
import { useMemo, useState } from "react";
import { orderedFacts, takeHomeText, type FactMap } from "@/lib/app/guestfeatures";
import { encodeQrText, qrRuns } from "@/lib/app/qr";
import { FACT_LABEL, FACT_SENSITIVE, TAKE_HOME_NOTE, TAKE_HOME_SHOW, TAKE_HOME_TITLE } from "@/lib/app/types";
import s from "./guest.module.css";

const QUIET = 4;

/** The QR as SVG rectangles (one per horizontal run of dark modules), black on white. */
function QrSvg({ text }: { text: string }) {
  const m = useMemo(() => {
    try {
      return encodeQrText(text, "M");
    } catch {
      return null;
    }
  }, [text]);
  if (!m) return <p className={s.small}>This card is too long for a QR code. Photograph the screen instead.</p>;
  const dim = m.size + QUIET * 2;
  return (
    <svg
      className={s.qr}
      viewBox={`0 0 ${dim} ${dim}`}
      role="img"
      aria-label="QR code holding the same text as this card"
      shapeRendering="crispEdges"
      data-qr-version={m.version}
    >
      <rect x="0" y="0" width={dim} height={dim} fill="#ffffff" />
      {qrRuns(m).map((r) => (
        <rect key={`${r.y}-${r.x}`} x={r.x + QUIET} y={r.y + QUIET} width={r.w} height="1" fill="#000000" />
      ))}
    </svg>
  );
}

export default function FactTiles({
  facts,
  interactive,
  onShown,
}: {
  facts: FactMap;
  interactive: boolean;
  /** Called each time the guest opens the card (counts "card shown" for the receipt; carries no text). */
  onShown?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const list = orderedFacts(facts);
  const text = takeHomeText(facts);
  if (list.length === 0) return null;

  return (
    <section className={s.facts} aria-labelledby="facts-title">
      <h2 id="facts-title" className={s.sectionTitle}>
        For you to keep
      </h2>
      <ul className={s.factGrid}>
        {list.map((f) => (
          <li key={f.key} className={s.factTile} data-key={f.key}>
            <span className={s.factLabel}>{FACT_LABEL[f.key]}</span>
            <span className={s.factValue}>{f.value}</span>
            {FACT_SENSITIVE[f.key] && <span className={s.factNote}>Not said aloud</span>}
          </li>
        ))}
      </ul>
      {interactive && text && (
        <>
          <button
            type="button"
            className={s.secondary}
            aria-expanded={open}
            aria-controls="take-home"
            onClick={() => {
              if (!open) onShown?.();
              setOpen((v) => !v);
            }}
          >
            {open ? "Hide my card" : TAKE_HOME_SHOW}
          </button>
          {open && (
            <div id="take-home" className={s.takeHome}>
              <div className={s.takeHomeText}>
                <p className={s.takeHomeTitle}>{TAKE_HOME_TITLE}</p>
                <dl className={s.takeHomeList}>
                  {list.map((f) => (
                    <div key={f.key}>
                      <dt>{FACT_LABEL[f.key]}</dt>
                      <dd>{f.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <QrSvg text={text} />
              <p className={s.takeHomeNote}>{TAKE_HOME_NOTE}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
