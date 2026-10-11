"use client";
// Picture request board (docs/features-plan.md F2): all 20 fixed guest requests as pictograms with a
// two-word label, drawn as inline SVG (no image files, no network). A tap opens the same BN-1
// confirmation as every other sentence; nothing reaches the desk before "Say it" or "Text only".
// No tile names a condition (FEATURE_STRATEGY feature 2).
import { useEffect, useRef, useState } from "react";
import { GUEST_INTENTS } from "@/lib/app/vocab";
import { BOARD_TILES, type BoardIcon, type GuestIntentId } from "@/lib/app/types";
import { ConfirmCard, type Session } from "./common";
import s from "./guest.module.css";

type Badge = "clock" | "pin" | "alert" | "moon";

/** Line pictograms on a 24-unit grid, in the style of hotel wayfinding signs. */
const MAIN: Readonly<Record<BoardIcon, string>> = {
  towels: "M3 6.5h18V10H3zM4.5 10h15v3.5h-15zM3 13.5h18v4H3zM7 6.5v3.5M17 13.5v4",
  wifi: "M2.5 9.2a14 14 0 0 1 19 0M5.6 12.6a9.6 9.6 0 0 1 12.8 0M8.8 16a5 5 0 0 1 6.4 0M12 19.4v.1",
  breakfast_time: "M3.5 8.5h11v4.5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM14.5 9.5h1a2.4 2.4 0 0 1 0 4.8h-1.2M7 3.5v2.2M10.5 3.5v2.2",
  breakfast_place: "M3.5 8.5h11v4.5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM14.5 9.5h1a2.4 2.4 0 0 1 0 4.8h-1.2M7 3.5v2.2M10.5 3.5v2.2",
  checkout_time: "M11 3.5H4v17h7M10 12h9.5M16.5 9l3 3-3 3",
  late_checkout: "M11 3.5H4v17h7M10 12h9.5M16.5 9l3 3-3 3",
  taxi: "M3 16.5V13l2.2-5h13.6L21 13v3.5zM3 16.5v2.5h3v-2.5M18 16.5v2.5h3v-2.5M9.5 8V5h5v3M6.5 13.2h.1M17.4 13.2h.1",
  room_where: "M3 19V6.5M3 15h18M21 19v-6a2 2 0 0 0-2-2h-8v4M5.5 11.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0",
  room_problem: "M10.5 8.5a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0M12 11.8 3.5 20.3M6 17.8l2.2 2.2M8.6 15.2l1.6 1.6",
  elevator: "M5 3h14v18H5zM9.2 9.5 12 6.5l2.8 3M9.2 14.5l2.8 3 2.8-3",
  parking: "M4 4h16v16H4zM9.5 17V7H13a3 3 0 0 1 0 6H9.5",
  restaurant_where: "M7 3v7.5M4.8 3v4.8a2.2 2.2 0 0 0 4.4 0V3M7 10.5V21M17 3c-2.2 1.2-3.2 3.8-3.2 7.5H17V21",
  restaurant_time: "M7 3v7.5M4.8 3v4.8a2.2 2.2 0 0 0 4.4 0V3M7 10.5V21M17 3c-2.2 1.2-3.2 3.8-3.2 7.5H17V21",
  reservation: "M4 5.5h16V20H4zM4 10h16M8.5 3v4.5M15.5 3v4.5M8.8 15l2.2 2.2 4.2-4.4",
  name: "M3 5h18v14H3zM6.8 10.3a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0-4.4 0M5.8 16.3c.6-1.7 1.8-2.6 3.2-2.6s2.6.9 3.2 2.6M14.5 9.5h4M14.5 13h4",
  help: "M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0M8.5 12a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M6.4 6.4l3.2 3.2M14.4 14.4l3.2 3.2M17.6 6.4l-3.2 3.2M9.6 14.4l-3.2 3.2",
  yes: "M4.5 12.5 9.5 17.5 19.5 6.5",
  no: "M6 6l12 12M18 6 6 18",
  thanks: "M12 20s-7.5-4.6-7.5-10.2A4.1 4.1 0 0 1 12 7.4a4.1 4.1 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z",
  done: "M5.5 21V3.5M5.5 4h12.5l-2.5 4.5 2.5 4.5H5.5",
};

const BADGE_OF: Readonly<Partial<Record<BoardIcon, Badge>>> = {
  breakfast_time: "clock",
  breakfast_place: "pin",
  checkout_time: "clock",
  late_checkout: "moon",
  room_where: "pin",
  room_problem: "alert",
  restaurant_where: "pin",
  restaurant_time: "clock",
};

const BADGE: Readonly<Record<Badge, string>> = {
  clock: "M5 12a7 7 0 1 0 14 0a7 7 0 1 0-14 0M12 8.2V12l2.6 1.6",
  pin: "M12 20.5s-6-5.6-6-10.3a6 6 0 0 1 12 0c0 4.7-6 10.3-6 10.3zM10.4 10.2a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0",
  alert: "M12 4 3.5 19.5h17zM12 10v4.2M12 16.8v.1",
  moon: "M18.5 14.6A7.2 7.2 0 1 1 9.4 5.5a5.8 5.8 0 0 0 9.1 9.1z",
};

export function BoardPictogram({ icon, className }: { icon: BoardIcon; className?: string }) {
  const badge = BADGE_OF[icon];
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className}>
      <path d={MAIN[icon]} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      {badge && (
        <g transform="translate(12.4 12.4) scale(0.52)">
          <circle cx="12" cy="12" r="11.5" className={s.boardBadgeBack} />
          <path d={BADGE[badge]} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
    </svg>
  );
}

const ANSWERS = new Set<GuestIntentId>([1, 2, 5, 20]);

/**
 * The board, or the confirmation for the tile just tapped. `compact` = shown inside the Sign panel
 * after two missed signs (no extra tap needed to reach it, F2 E4).
 */
export default function PictureBoard({ session, compact = false }: { session: Session; compact?: boolean }) {
  const { ui, act, sendingVia, unsentRef } = session;
  const [picked, setPicked] = useState<GuestIntentId | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const intent = picked ? (GUEST_INTENTS.find((g) => g.id === picked) ?? null) : null;
  const tile = picked ? BOARD_TILES.find((t) => t.intentId === picked) : undefined;

  useEffect(() => {
    unsentRef.current = picked !== null;
  }, [picked, unsentRef]);
  useEffect(() => {
    if (picked) cardRef.current?.querySelector<HTMLElement>("[data-actions]")?.scrollIntoView({ block: "nearest" });
  }, [picked]);

  if (intent && tile) {
    return (
      <div className={`${s.card} ${s.boardConfirm}`} ref={cardRef}>
        <div className={s.boardPicked}>
          <BoardPictogram icon={tile.icon} className={s.boardPickedIcon} />
          <span>{tile.label}</span>
        </div>
        <ConfirmCard
          ui={ui}
          item={{ text: intent.needsName ? "My name is ..." : intent.text, needsName: intent.needsName }}
          signs={null}
          simulated={false}
          testMode={false}
          heading="You tapped:"
          onSend={async (how) => {
            sendingVia("board");
            const r = await act({ type: "guest_phrase", intentId: intent.id, via: "board", voice: how.voice, ...(how.name ? { name: how.name } : {}) });
            if (r.ok) {
              setSent(tile.label);
              setPicked(null);
            }
            return r;
          }}
          fixOptions={[
            { label: "Pick another picture", run: () => setPicked(null) },
            { label: "Type instead", run: () => void act({ type: "guest_choice", choice: "type" }) },
          ]}
        />
      </div>
    );
  }

  const tiles = (answers: boolean) =>
    BOARD_TILES.filter((t) => ANSWERS.has(t.intentId) === answers).map((t) => (
      <li key={t.intentId}>
        <button
          type="button"
          className={s.boardTile}
          data-answer={answers || undefined}
          onClick={() => {
            setPicked(t.intentId);
            setSent(null);
          }}
        >
          <BoardPictogram icon={t.icon} className={s.boardIcon} />
          <span className={s.boardLabel}>{t.label}</span>
        </button>
      </li>
    ));

  return (
    <div className={s.board} data-compact={compact || undefined}>
      {!compact && <p className={s.small}>Tap a picture. You check the sentence before the desk sees it.</p>}
      {sent && !ui.echo && (
        <p className={s.small} role="status">
          Sent: {sent}
        </p>
      )}
      <ul className={s.boardGrid} aria-label="Requests">
        {tiles(false)}
      </ul>
      <h3 className={s.subTitle} id={compact ? "board-answers-c" : "board-answers"}>
        Quick answers
      </h3>
      <ul className={`${s.boardGrid} ${s.boardAnswers}`} aria-labelledby={compact ? "board-answers-c" : "board-answers"}>
        {tiles(true)}
      </ul>
    </div>
  );
}
