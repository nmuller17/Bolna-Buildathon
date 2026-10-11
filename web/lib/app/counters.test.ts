// Equal-access counters and the privacy receipt (docs/features-plan.md F16, F17). `npm run test:unit`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReceipt, emptyEqualAccess, emptyUse, equalAccessRows, FEWER_THAN, noteCaptionBackend, noteUse, shownCount } from "./counters.ts";
import type { PrivacyCounters } from "./types.ts";

const privacy = (calls: PrivacyCounters["vendorCalls"] = []): PrivacyCounters => ({
  vendorKeysConfigured: [],
  vendorCalls: calls,
  guestBytesOffLaptop: 0,
  messagesToGuest: 0,
  bytesToGuest: 0,
  bridgeEvents: 0,
  refusedBodyKeys: { face: 0, frames: 0, pose: 0, video: 0 },
  skeletonsHeld: 0,
  ttsFixedSentences: 0,
});

test("F16-1: small counts (zero included) are shown as 'fewer than 5'; every panel row goes through it", () => {
  assert.equal(FEWER_THAN, "fewer than 5");
  for (const n of [0, 1, 4]) assert.equal(shownCount(n), "fewer than 5");
  assert.equal(shownCount(5), "5");
  const c = emptyEqualAccess();
  c.sessions = 7;
  c.modeChosen.tap = 2;
  const rows = equalAccessRows(c);
  assert.equal(rows[0].value, "7");
  assert.ok(rows.every((r) => r.value === "fewer than 5" || /^\d+$/.test(r.value)));
  assert.equal(rows.find((r) => r.label === "Chose to tap pictures")?.value, "fewer than 5");
  assert.ok(!JSON.stringify(c).match(/"at"|time|Date/i), "no timestamps in the counters");
});

test("F17-2: the receipt lists exactly the ways used, caption backends and vendors, from real data; offline: none", () => {
  const u = emptyUse();
  noteUse(u, "board");
  noteUse(u, "typed");
  noteUse(u, "typed_match");
  noteUse(u, "board");
  noteCaptionBackend(u, "local");
  const r = buildReceipt(u, privacy(), 1000, 12);
  assert.deepEqual(r, { used: ["Pictures", "Typing"], captionBackends: ["local"], voice: "none", vendors: [], erasedAt: 1000, itemsErased: 12 });
  u.voiced = true;
  assert.equal(buildReceipt(u, privacy(), 1, 1).voice, "on_device");
  const withTts = buildReceipt(u, privacy([{ destination: "api.elevenlabs.io", purpose: "", route: "/api/tts", count: 2, bytesSent: 10, guestData: true, observedBy: "server_wrapper" }]), 1, 1);
  assert.equal(withTts.voice, "cloud");
  assert.deepEqual(withTts.vendors, ["ElevenLabs (voice for your fixed sentences)"]);
  noteCaptionBackend(u, "browser_apple");
  assert.deepEqual(buildReceipt(u, privacy(), 1, 1).vendors, ["Apple (speech recognition of the desk's voice)"]);
});
