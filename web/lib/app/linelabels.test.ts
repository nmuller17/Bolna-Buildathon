// F6-1: every staff log line kind that is a conversation line has exactly one machine-or-human label.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LOG_KIND_IS_LINE, staffLineLabel } from "./linelabels.ts";
import type { LogEntry } from "./types.ts";

const base = { seq: 1, at: 1 };
const SAMPLES: LogEntry[] = [
  { ...base, kind: "staff", id: "c1", text: "Welcome!", gloss: [], captionSource: "quick_reply", glossSource: "fixed_intent", intent: "welcome", shownOnDeviceAt: null, guestReply: null },
  { ...base, kind: "staff", id: "c2", text: "Hi", gloss: [], captionSource: "typed", glossSource: "none", intent: null, shownOnDeviceAt: null, guestReply: null },
  { ...base, kind: "staff", id: "c3", text: "Hi", gloss: [], captionSource: "voice", glossSource: "none", intent: null, shownOnDeviceAt: null, guestReply: null },
  { ...base, kind: "live_caption", utteranceId: "u", text: "Hello", backend: "local", retracted: false },
  { ...base, kind: "guest", proposalId: "p", text: "Yes.", signs: [], intentId: 1, source: "gate", speak: { mode: "none", why: "text_only" }, spokenAt: null, confirmedBy: "guest", simulated: false },
  { ...base, kind: "guest", proposalId: "p", text: "Yes.", signs: [], intentId: 1, source: "gate", speak: { mode: "none", why: "text_only" }, spokenAt: null, confirmedBy: "staff_for_guest", simulated: false },
  { ...base, kind: "guest", proposalId: "p", text: "More towels.", signs: [], intentId: 10, source: "phrase", speak: { mode: "none", why: "text_only" }, spokenAt: null, confirmedBy: "guest", simulated: false, via: "board" },
  { ...base, kind: "guest", proposalId: "p", text: "More towels.", signs: [], intentId: 10, source: "phrase", speak: { mode: "none", why: "text_only" }, spokenAt: null, confirmedBy: "guest", simulated: false },
  { ...base, kind: "guest_typed", text: "hi", readAloudAt: null },
  { ...base, kind: "guest_number", about: "nights", value: "3" },
  { ...base, kind: "guest_reply", reply: "slower", captionId: null },
  { ...base, kind: "guest_setting", text: "x" },
  { ...base, kind: "repeat", reason: "framing", recognizerSaidRepeat: false },
  { ...base, kind: "system", text: "x" },
] as LogEntry[];

test("F6-1: every conversation line kind has a label; notices have none; each sample maps as expected", () => {
  for (const k of Object.keys(LOG_KIND_IS_LINE) as LogEntry["kind"][]) assert.ok(SAMPLES.some((e) => e.kind === k), `sample for ${k}`);
  for (const e of SAMPLES) assert.equal(staffLineLabel(e) !== null, LOG_KIND_IS_LINE[e.kind], e.kind);
  assert.deepEqual(SAMPLES.map(staffLineLabel), [
    "Staff quick reply",
    "Typed by staff",
    "Staff speech, reviewed by staff",
    "Staff speech, machine captions",
    "Signs recognised, confirmed by guest",
    "Signs recognised, confirmed by staff",
    "Tapped on board",
    "Picked from the list",
    "Typed by guest",
    "Typed by guest",
    "Repair request tapped by guest",
    null,
    null,
    null,
  ]);
});
