// Take-home card QR encoder (docs/features-plan.md F4). Structural checks that need no decoder.
// The full round trip (encode here, decode with OpenCV's QRCodeDetectorAruco, 26 texts from 5 to
// 900 bytes, versions 1 to 24, plus UTF-8 text) is recorded in PROGRESS_LIVE_features.md.
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeQrText, qrByteCapacity, qrRuns, type QrMatrix } from "./qr.ts";

const FORMAT_BITS: Record<string, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** Reads the 15 format bits around the top-left finder (the copy decoders read first). */
function readFormat(m: QrMatrix): number {
  const g = (x: number, y: number) => (m.modules[y][x] ? 1 : 0);
  let bits = 0;
  const cells: [number, number][] = [];
  for (let i = 0; i <= 5; i++) cells.push([8, i]);
  cells.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) cells.push([14 - i, 8]);
  cells.forEach(([x, y], i) => (bits |= g(x, y) << i));
  return bits;
}

function expectedFormat(ecc: string, mask: number): number {
  const data = (FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function finderAt(m: QrMatrix, x0: number, y0: number): boolean {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if (m.modules[y0 + dy][x0 + dx] !== (ring !== 2)) return false;
    }
  }
  return true;
}

const CARD =
  "Your hotel card\nRoom: 517\nWi-Fi network: Harbor-Guest\nWi-Fi password: blue-otter-42\nBreakfast: 7 to 10\nCheckout: 11 am\nText the front desk: 555-0142";

test("version 1 for a short text, 21 modules, raised error correction", () => {
  const m = encodeQrText("Hello");
  assert.equal(m.version, 1);
  assert.equal(m.size, 21);
  assert.equal(m.modules.length, 21);
  assert.ok(m.modules.every((r) => r.length === 21));
  assert.equal(m.ecc, "H");
});

test("a typical card fits a phone-scannable version and keeps at least level M", () => {
  const m = encodeQrText(CARD);
  assert.ok(m.version <= 10, `version ${m.version}`);
  assert.equal(m.size, m.version * 4 + 17);
  assert.ok(["M", "Q", "H"].includes(m.ecc));
});

test("finder patterns, timing patterns and the dark module are where decoders look", () => {
  for (const t of ["Hello", CARD, "x".repeat(400)]) {
    const m = encodeQrText(t);
    assert.ok(finderAt(m, 0, 0), "top-left finder");
    assert.ok(finderAt(m, m.size - 7, 0), "top-right finder");
    assert.ok(finderAt(m, 0, m.size - 7), "bottom-left finder");
    for (let i = 8; i < m.size - 8; i++) {
      assert.equal(m.modules[6][i], i % 2 === 0, `timing row at ${i}`);
      assert.equal(m.modules[i][6], i % 2 === 0, `timing column at ${i}`);
    }
    assert.equal(m.modules[m.size - 8][8], true, "dark module");
  }
});

test("format bits encode the chosen level and mask (BCH code)", () => {
  for (const t of ["Hello", CARD, "Room: 1204", "y".repeat(250)]) {
    const m = encodeQrText(t);
    assert.equal(readFormat(m), expectedFormat(m.ecc, m.mask));
  }
});

test("deterministic: the same text always gives the same matrix", () => {
  assert.deepEqual(encodeQrText(CARD), encodeQrText(CARD));
});

test("UTF-8 text is accepted; too long a text throws instead of truncating", () => {
  assert.doesNotThrow(() => encodeQrText("Café — 7–10 ✓"));
  assert.throws(() => encodeQrText("z".repeat(qrByteCapacity("M") + 1)), RangeError);
  assert.doesNotThrow(() => encodeQrText("z".repeat(qrByteCapacity("M"))));
});

test("runs cover exactly the dark modules", () => {
  const m = encodeQrText(CARD);
  const dark = m.modules.flat().filter(Boolean).length;
  const covered = qrRuns(m).reduce((n, r) => n + r.w, 0);
  assert.equal(covered, dark);
});
