// P4: check-in co-pilot for the staff screen (inspired by ProtoCopilot-style meeting checklists).
//
// It answers one question for the receptionist: which of the standard check-in items has the guest
// actually been given? An item is ticked only when
//   - "sent": a staff sentence that carries it was signed and captioned on the guest screen, or
//   - "confirmed": the guest signed a sentence that settles it (for example YES RESERVATION).
// A guest question about an item that was not shared yet is a hint ("guest asked, not answered yet"),
// never a tick. Shown on the guest screen does not mean understood, so the panel says so.
//
// Pure functions over plain data, no imports at runtime (only erased type imports), so Node's type
// stripping runs the unit tests without a bundler: node --test lib/app/checklist.test.mjs
// Nothing here is stored: the list lives in React state and is gone on reload or "Reset checklist".
import type { StaffIntentId } from "../voice/intents";

export type CheckinItemKey =
  | "greeting"
  | "reservation"
  | "guest_name"
  | "id"
  | "nights"
  | "room_number"
  | "key_card"
  | "elevator"
  | "wifi"
  | "breakfast"
  | "checkout"
  | "anything_else"
  | "farewell";

export type CheckinItemDef = {
  key: CheckinItemKey;
  label: string;
  /** Staff intents (web/lib/voice/intents.ts) whose sentence shares this item with the guest. */
  staffIntents: readonly StaffIntentId[];
  /** Guest sign sequences (docs/vocabulary.md section 2) that settle the item. */
  guestConfirms: readonly (readonly string[])[];
  /** Guest sign sequences that ask about the item: a hint while it is not shared yet. */
  guestAsks: readonly (readonly string[])[];
};

/** The standard check-in items, in the order of the demo script. Reminders only; nothing blocks. */
export const CHECKIN_ITEMS: readonly CheckinItemDef[] = [
  { key: "greeting", label: "Greeting", staffIntents: ["welcome"], guestConfirms: [], guestAsks: [] },
  { key: "reservation", label: "Reservation", staffIntents: ["reservation_question"], guestConfirms: [["YES", "RESERVATION"]], guestAsks: [] },
  { key: "guest_name", label: "Guest name", staffIntents: ["name_question"], guestConfirms: [], guestAsks: [] },
  { key: "id", label: "Photo ID asked for", staffIntents: ["id_please"], guestConfirms: [], guestAsks: [] },
  { key: "nights", label: "Number of nights", staffIntents: ["nights_question"], guestConfirms: [], guestAsks: [] },
  { key: "room_number", label: "Room number", staffIntents: ["room_number"], guestConfirms: [], guestAsks: [["WHERE", "ROOM"]] },
  { key: "key_card", label: "Key card", staffIntents: ["key_card"], guestConfirms: [], guestAsks: [] },
  { key: "elevator", label: "Elevator", staffIntents: ["elevator_left"], guestConfirms: [], guestAsks: [["WHERE", "ELEVATOR"]] },
  { key: "wifi", label: "Wi-Fi password", staffIntents: ["wifi_password"], guestConfirms: [], guestAsks: [["FS-WIFI", "PASSWORD"]] },
  {
    key: "breakfast",
    label: "Breakfast",
    staffIntents: ["breakfast_time"],
    guestConfirms: [],
    guestAsks: [["BREAKFAST", "TIME"], ["WHERE", "BREAKFAST"]],
  },
  {
    key: "checkout",
    label: "Checkout time",
    staffIntents: ["checkout_time", "late_checkout"],
    guestConfirms: [],
    guestAsks: [["LEAVE", "TIME"], ["LATE", "LEAVE", "PLEASE"]],
  },
  { key: "anything_else", label: "Anything else?", staffIntents: ["anything_else"], guestConfirms: [["NO", "THANK-YOU"]], guestAsks: [] },
  { key: "farewell", label: "Farewell", staffIntents: ["enjoy_stay"], guestConfirms: [], guestAsks: [] },
];

/** Fixed note at the top of the panel. */
export const CHECKLIST_NOTE = "Shown on the guest screen does not mean understood. Pause and check with the guest.";

export type CheckinItemState = "not_shared" | "sent" | "confirmed";

export type CheckinItemStatus = {
  key: CheckinItemKey;
  state: CheckinItemState;
  /** Date.now() of the send or the guest's confirmation; null while not shared. */
  at: number | null;
  /** The sentence that shared or settled it, as evidence. */
  sentence: string | null;
  /** When the guest asked about it while it was not shared yet; cleared once it is shared. */
  guestAskedAt: number | null;
};

export function initChecklist(): CheckinItemStatus[] {
  return CHECKIN_ITEMS.map((i) => ({ key: i.key, state: "not_shared", at: null, sentence: null, guestAskedAt: null }));
}

const sameSigns = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((s, i) => s === b[i]);

function update(
  list: CheckinItemStatus[],
  hit: (def: CheckinItemDef) => boolean,
  f: (s: CheckinItemStatus) => CheckinItemStatus,
): CheckinItemStatus[] {
  const keys = new Set(CHECKIN_ITEMS.filter(hit).map((d) => d.key));
  if (keys.size === 0) return list;
  return list.map((s) => (keys.has(s.key) ? f(s) : s));
}

/**
 * A staff sentence was signed and captioned on the guest screen. `intents` are the staff intents found in
 * it (mapStaffTextToGloss(text).matches). An item already settled by the guest stays "confirmed".
 */
export function onStaffSent(list: CheckinItemStatus[], intents: readonly StaffIntentId[], sentence: string, at: number): CheckinItemStatus[] {
  return update(
    list,
    (def) => def.staffIntents.some((i) => intents.includes(i)),
    (s) => (s.state === "confirmed" ? s : { ...s, state: "sent", at, sentence, guestAskedAt: null }),
  );
}

/**
 * The guest signed a sentence (the utterance's labels, after correction). Skip repeats and mock-mode
 * utterances before calling: an unconfirmed guess must never tick anything.
 */
export function onGuestSigned(list: CheckinItemStatus[], labels: readonly string[], sentence: string, at: number): CheckinItemStatus[] {
  const confirmed = update(
    list,
    (def) => def.guestConfirms.some((seq) => sameSigns(seq, labels)),
    (s) => ({ ...s, state: "confirmed", at, sentence, guestAskedAt: null }),
  );
  return update(
    confirmed,
    (def) => def.guestAsks.some((seq) => sameSigns(seq, labels)),
    (s) => (s.state !== "not_shared" || s.guestAskedAt !== null ? s : { ...s, guestAskedAt: at }),
  );
}

export const isTicked = (s: CheckinItemStatus) => s.state !== "not_shared";

/**
 * Gentle reminder once the conversation is wrapping up ("Anything else?" or "Enjoy your stay!" was shared,
 * or the guest signed "No, that's all"): the labels of the items still not shared. Empty otherwise.
 */
export function notSharedBeforeGoodbye(list: CheckinItemStatus[]): string[] {
  const wrapping = list.some((s) => (s.key === "anything_else" || s.key === "farewell") && isTicked(s));
  if (!wrapping) return [];
  const open = new Set(list.filter((s) => !isTicked(s)).map((s) => s.key));
  return CHECKIN_ITEMS.filter((d) => open.has(d.key) && d.key !== "anything_else" && d.key !== "farewell").map((d) => d.label);
}
