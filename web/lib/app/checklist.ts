// SignBridge app (P4, builder A): the check-in co-pilot reducer (docs/app-plan.md 4.2, DSH-2, GST-11).
//
// An item is "shared" only when the guest device acknowledged rendering a staff line that carries
// one of its intents; "sent" before that; "needs_retry" after the guest tapped "Please repeat" or
// "I don't understand" under that line; "not_shared" otherwise. It tracks staff actions only: no
// guest response times, no repeat counts. Pure functions over plain data.
import {
  CHECKIN_ITEMS,
  type CheckinItemKey,
  type CheckinItemStatus,
  type GuestIntentId,
  type GuestReplyKind,
  type StaffIntentKey,
} from "./types.ts";

export function initChecklist(): CheckinItemStatus[] {
  return CHECKIN_ITEMS.map((i) => ({ key: i.key, state: "not_shared", at: null, sentence: null, guestAskedAt: null, seenByStaff: false }));
}

function update(list: CheckinItemStatus[], match: (key: CheckinItemKey) => boolean, f: (s: CheckinItemStatus) => CheckinItemStatus): CheckinItemStatus[] {
  return list.map((s) => (match(s.key) ? f(s) : s));
}

const itemsForStaffIntent = (intent: StaffIntentKey) =>
  new Set(CHECKIN_ITEMS.filter((i) => i.staffIntents.includes(intent)).map((i) => i.key));

/** A staff line carrying `intent` was sent to the guest device. A shared item stays shared. */
export function onStaffSent(list: CheckinItemStatus[], intent: StaffIntentKey | null, sentence: string, at: number): CheckinItemStatus[] {
  if (!intent) return list;
  const keys = itemsForStaffIntent(intent);
  return update(list, (k) => keys.has(k), (s) => (s.state === "shared" ? s : { ...s, state: "sent", at, sentence }));
}

/** The guest device acknowledged rendering that line. */
export function onDelivered(list: CheckinItemStatus[], intent: StaffIntentKey | null, sentence: string, at: number): CheckinItemStatus[] {
  if (!intent) return list;
  const keys = itemsForStaffIntent(intent);
  return update(list, (k) => keys.has(k), (s) => (s.state === "needs_retry" && s.at !== null && s.at > at ? s : { ...s, state: "shared", at, sentence }));
}

/** The guest tapped a repair reply under a line carrying `intent`. Only "repeat" and "don't understand" mean "needs another try". */
export function onGuestReply(list: CheckinItemStatus[], intent: StaffIntentKey | null, reply: GuestReplyKind, at: number): CheckinItemStatus[] {
  if (!intent || (reply !== "please_repeat" && reply !== "dont_understand")) return list;
  const keys = itemsForStaffIntent(intent);
  return update(list, (k) => keys.has(k), (s) => ({ ...s, state: "needs_retry", at }));
}

/** The guest asked about an item (a confirmed guest intent) before it was shared: "guest asked; not answered yet". */
export function onGuestAsked(list: CheckinItemStatus[], intentId: GuestIntentId | null, at: number): CheckinItemStatus[] {
  if (intentId === null) return list;
  const keys = new Set(CHECKIN_ITEMS.filter((i) => i.guestAsks.includes(intentId)).map((i) => i.key));
  return update(list, (k) => keys.has(k), (s) => (s.state === "shared" || s.guestAskedAt !== null ? s : { ...s, guestAskedAt: at }));
}

/** Staff ticked a manual item ("I saw it", e.g. the ID check on paper). */
export function onSeen(list: CheckinItemStatus[], key: CheckinItemKey, at: number): CheckinItemStatus[] {
  const def = CHECKIN_ITEMS.find((i) => i.key === key);
  if (!def || !def.manual) return list;
  return update(list, (k) => k === key, (s) => ({ ...s, state: "shared", at, seenByStaff: true }));
}
