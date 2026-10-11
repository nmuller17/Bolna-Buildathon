// SignBridge staff log (P4, builder S): one machine-or-human label per conversation line
// (docs/features-plan.md F6). The guest record uses the same words (guestfeatures.ts), so both screens
// say the same thing about the same line. App notices (system lines, settings, repeat requests) are
// not conversation lines and carry no label.
import { DESK_LINE_LABEL, GUEST_LINE_LABEL } from "./guestfeatures.ts";
import type { LineSourceLabel, LogEntry } from "./types.ts";

type Kind = LogEntry["kind"];

/** Every log kind, with whether it is a conversation line (and so must have a label). */
export const LOG_KIND_IS_LINE: Readonly<Record<Kind, boolean>> = {
  staff: true,
  live_caption: true,
  guest: true,
  guest_typed: true,
  guest_number: true,
  guest_reply: true,
  guest_setting: false,
  repeat: false,
  system: false,
};

export function staffLineLabel(e: LogEntry): LineSourceLabel | null {
  switch (e.kind) {
    case "staff":
      return DESK_LINE_LABEL[e.captionSource];
    case "live_caption":
      return DESK_LINE_LABEL.live_caption;
    case "guest":
      if (e.via) return GUEST_LINE_LABEL[e.via];
      if (e.source === "phrase") return GUEST_LINE_LABEL.phrase_list;
      return e.confirmedBy === "staff_for_guest" ? "Signs recognised, confirmed by staff" : GUEST_LINE_LABEL.signs;
    case "guest_typed":
      return GUEST_LINE_LABEL.typed;
    case "guest_number":
      return GUEST_LINE_LABEL.number;
    case "guest_reply":
      return "Repair request tapped by guest";
    case "guest_setting":
    case "repeat":
    case "system":
      return null;
  }
}
