// Route-level tests for the Tier 0 server (docs/app-plan.md 8, 9, 11): the real handlers of routes.ts
// driven with plain Request objects, a real Store with a fake clock and the real staff capability.
// No server, no network, no browser. Run with `npm run test:unit`.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { RateLimiter } from "./access.ts";
import {
  bridgeGet,
  bridgePost,
  events,
  guestAction,
  guestJoin,
  guestLeave,
  simulate,
  staffAction,
  staffBenchmark,
  staffClaim,
  type RouteDeps,
} from "./routes.ts";
import { claimCapability, isStaffToken, issueCapability, resetStaffCapability } from "./staffcap.ts";
import { Store, defaultConfig, type StoreConfig } from "./store.ts";
import { LIMITS } from "./types.ts";

const T0 = 1_760_112_000_000;
const PROOF = "proof-of-loopback-for-tests";
const BRIDGE = "b".repeat(40);
const CANARY = "Zq7Canary";
/** Names allow letters only (SPK-6), so the name canary has no digit. */
const NAME_CANARY = "Zqsevencanary";

type World = {
  store: Store;
  deps: RouteDeps;
  tick: (ms: number) => void;
  staffCookie: string;
};

function world(cfg: Partial<StoreConfig> = {}, extra: Partial<RouteDeps> = {}): World {
  let now = T0;
  let n = 0;
  const store = new Store(defaultConfig({ profile: "stage", mode0GuestInputRequested: true, simulate: true, ...cfg }), {
    now: () => now,
    randomHex: (bytes) => (++n).toString(16).padStart(bytes * 2, "a"),
  });
  const limiters = new Map<string, RateLimiter>();
  const deps: RouteDeps = {
    store,
    port: 3000,
    proof: PROOF,
    bridgeKey: BRIDGE,
    simulate: store.config.simulate,
    limit: (name, max, windowMs) => {
      let l = limiters.get(name);
      if (!l) limiters.set(name, (l = new RateLimiter(max, windowMs, () => now)));
      return l.take();
    },
    staff: { isToken: isStaffToken, claim: claimCapability },
    readBenchmark: () => null,
    ...extra,
  };
  resetStaffCapability();
  const k = issueCapability();
  const r = claimCapability(k);
  assert.ok(r.ok);
  return { store, deps, tick: (ms) => (now += ms), staffCookie: `sb_staff=${r.token}` };
}

type ReqOpts = { method?: string; host?: string; origin?: string | null; site?: string | null; cookie?: string; body?: unknown; ct?: string | null; proof?: string | null; ua?: string; headers?: Record<string, string> };

function req(path: string, o: ReqOpts = {}): Request {
  const host = o.host ?? "127.0.0.1:3000";
  const h: Record<string, string> = { host, "user-agent": o.ua ?? "TestBrowser/1", ...(o.headers ?? {}) };
  if (o.proof !== null) {
    h["x-sb-proof"] = o.proof ?? PROOF;
    h["x-sb-loopback"] = "1";
  }
  if (o.origin !== null) h.origin = o.origin ?? `http://${host}`;
  if (o.site !== null) h["sec-fetch-site"] = o.site ?? "same-origin";
  if (o.cookie) h.cookie = o.cookie;
  let body: string | undefined;
  if (o.body !== undefined) {
    body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
    if (o.ct !== null) h["content-type"] = o.ct ?? "application/json";
  }
  return new Request(`http://${host}${path}`, { method: o.method ?? (body === undefined ? "GET" : "POST"), headers: h, body });
}

const staffReq = (w: World, body: unknown, o: ReqOpts = {}) => req("/api/staff/action", { cookie: w.staffCookie, body, ...o });
const guestReq = (path: string, body: unknown, cookie: string | undefined, o: ReqOpts = {}) => req(path, { host: "localhost:3000", cookie, body, ...o });
const bridgeReq = (body: unknown, o: ReqOpts = {}) =>
  req("/api/guest/signs", { origin: null, site: null, body, headers: { "x-bridge-key": BRIDGE, ...(o.headers ?? {}) }, ...o });

const nonce = (() => {
  let i = 0;
  return () => (++i).toString(16).padStart(32, "0");
})();

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Collects what an SSE response sends, without waiting for the end. */
function collect(res: Response) {
  const chunks: string[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let done = false;
  (async () => {
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done) break;
      chunks.push(dec.decode(r.value));
    }
    done = true;
  })();
  const flush = () => new Promise((r) => setTimeout(r, 5));
  return {
    text: async () => {
      await flush();
      return chunks.join("");
    },
    messages: async () => {
      await flush();
      return chunks
        .join("")
        .split("\n\n")
        .flatMap((b) => b.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)).msg as Record<string, unknown>));
    },
    ended: () => done,
    cancel: () => reader.cancel(),
  };
}

/** New guest, open the guest window, join on localhost: the Mode 0 flow of plan 4.3. Returns the guest cookie. */
async function startGuest(w: World): Promise<string> {
  assert.equal((await staffAction(staffReq(w, { type: "new_guest" }), w.deps)).status, 200);
  const opened = await body(await staffAction(staffReq(w, { type: "open_guest_window" }), w.deps));
  const url = new URL(String(opened.guestUrl));
  assert.equal(url.origin, "http://localhost:3000");
  const code = url.hash.slice("#p=".length);
  const res = await guestJoin(guestReq("/api/guest/join", { code }, undefined), w.deps);
  assert.equal(res.status, 200);
  const set = res.headers.get("set-cookie") ?? "";
  assert.match(set, /^sb_g=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/$/);
  return set.split(";")[0];
}

const act = (w: World, cookie: string, a: Record<string, unknown>, o: ReqOpts = {}) =>
  guestAction(guestReq("/api/guest/action", { n: nonce(), ...a }, cookie, o), w.deps);

const recognizerUp = async (w: World) =>
  assert.equal((await bridgePost(bridgeReq({ type: "status", recognizer: "ok", fps: 27 }), w.deps)).status, 200);

beforeEach(() => resetStaffCapability());

/* ------------------------------ staff capability ------------------------------ */

test("SRV-10: the one-time staff link is claimed once; a wrong key is 403; SIGUSR2's new link replaces the cookie", async () => {
  const w = world();
  resetStaffCapability();
  const k = issueCapability();
  const claim = (key: string) => staffClaim(req("/api/staff/claim", { body: { k: key } }), w.deps);
  assert.equal((await claim("x".repeat(43))).status, 403);
  const ok = await claim(k);
  assert.equal(ok.status, 200);
  const set = ok.headers.get("set-cookie") ?? "";
  assert.match(set, /^sb_staff=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.doesNotMatch(JSON.stringify(await body(ok)), /sb_staff|[A-Za-z0-9_-]{40,}/, "the token is never in the body");
  assert.equal((await claim(k)).status, 410, "second claim");
  const first = set.split(";")[0];
  assert.equal((await staffAction(staffReq({ ...w, staffCookie: first }, { type: "touch" }), w.deps)).status, 409, "cookie works (no session yet)");
  const k2 = issueCapability(); // what server.mjs does on SIGUSR2
  const again = await claim(k2);
  assert.equal(again.status, 200);
  assert.equal((await staffAction(staffReq({ ...w, staffCookie: first }, { type: "touch" }), w.deps)).status, 401, "the old staff cookie is replaced");
  // The claim route itself answers only on the staff Host.
  assert.equal((await staffClaim(req("/api/staff/claim", { host: "localhost:3000", body: { k: "y".repeat(43) } }), w.deps)).status, 403);
});

test("SRV-4a: staff routes need loopback proof, Host 127.0.0.1, same origin and the staff cookie", async () => {
  const w = world();
  const a = { type: "new_guest" };
  assert.equal((await staffAction(staffReq(w, a, { proof: null }), w.deps)).status, 403, "no server.mjs proof");
  assert.equal((await staffAction(staffReq(w, a, { proof: "forged" }), w.deps)).status, 403, "forged proof");
  assert.equal((await staffAction(staffReq(w, a, { host: "localhost:3000" }), w.deps)).status, 403, "guest host");
  assert.equal((await staffAction(staffReq(w, a, { host: "evil.example:3000" }), w.deps)).status, 403, "foreign host");
  assert.equal((await staffAction(staffReq(w, a, { origin: "http://evil.example", site: "cross-site" }), w.deps)).status, 403, "cross-site");
  assert.equal((await staffAction(req("/api/staff/action", { body: a }), w.deps)).status, 401, "no cookie");
  assert.equal((await staffAction(staffReq(w, a, { ct: "text/plain" }), w.deps)).status, 415);
  assert.equal((await staffAction(staffReq(w, "{", {}), w.deps)).status, 400);
  assert.equal((await staffAction(staffReq(w, { type: "say_quick", intent: "welcome", extra: 1 }), w.deps)).status, 400, "unknown keys refused");
  assert.equal((await staffAction(staffReq(w, { type: "say_text", text: "x".repeat(5000), gloss: null, source: "typed" }), w.deps)).status, 413);
  assert.equal((await staffAction(staffReq(w, a), w.deps)).status, 200);
  assert.equal((await staffBenchmark(req("/api/staff/benchmark", { cookie: w.staffCookie }), w.deps)).status, 200);
  assert.deepEqual(await body(await staffBenchmark(req("/api/staff/benchmark", { cookie: w.staffCookie }), w.deps)), { ok: true, status: "not_yet_audited" });
  assert.equal((await staffBenchmark(req("/api/staff/benchmark"), w.deps)).status, 401);
});

/* ------------------------------ Mode 0 pairing ------------------------------ */

test("SES-1a/SES-4a/SES-13: Mode 0 join on localhost only, single use, cookie never in the body, separate cookie sites", async () => {
  const w = world();
  await staffAction(staffReq(w, { type: "new_guest" }), w.deps);
  const opened = await body(await staffAction(staffReq(w, { type: "open_guest_window" }), w.deps));
  const code = new URL(String(opened.guestUrl)).hash.slice(3);
  assert.ok(code.length >= 22, "128-bit code");
  // A join on the staff host is refused and does not burn the code.
  assert.equal((await guestJoin(req("/api/guest/join", { body: { code } }), w.deps)).status, 403);
  assert.equal((await guestJoin(guestReq("/api/guest/join", { code }, undefined, { origin: "http://127.0.0.1:3000" }), w.deps)).status, 403, "staff origin");
  const ok = await guestJoin(guestReq("/api/guest/join", { code }, undefined), w.deps);
  assert.equal(ok.status, 200);
  const okBody = JSON.stringify(await body(ok));
  const token = (ok.headers.get("set-cookie") ?? "").split(";")[0].split("=")[1];
  assert.ok(!okBody.includes(token), "the guest token is never in the body");
  assert.equal((await guestJoin(guestReq("/api/guest/join", { code }, undefined), w.deps)).status, 410, "second join with the same code");
  assert.equal(w.store.warnings.some((x) => x.kind === "second_device"), true, "a reused code is reported");
  // Guest actions on the staff host are refused (the staff window cannot act as the guest).
  assert.equal((await guestAction(req("/api/guest/action", { cookie: `sb_g=${token}`, body: { n: nonce(), type: "heartbeat" } }), w.deps)).status, 403);
});

test("SES-1a: the pairing code expires after 120 s", async () => {
  const w = world();
  await staffAction(staffReq(w, { type: "new_guest" }), w.deps);
  const opened = await body(await staffAction(staffReq(w, { type: "open_guest_window" }), w.deps));
  const code = new URL(String(opened.guestUrl)).hash.slice(3);
  w.tick(LIMITS.pairCodeTtlMs + 1);
  assert.equal((await guestJoin(guestReq("/api/guest/join", { code }, undefined), w.deps)).status, 410);
});

/* ------------------------------ streams ------------------------------ */

test("SES-7: staff and guest streams send retry, hello and snapshot; a dead guest cookie gets 401 and is expired", async () => {
  const w = world();
  const g = await startGuest(w);
  const staff = await events(req("/api/events?role=staff", { cookie: w.staffCookie, origin: null }), w.deps);
  assert.equal(staff.status, 200);
  assert.match(staff.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(staff.headers.get("cache-control"), "no-store, no-transform");
  const sc = collect(staff);
  assert.match(await sc.text(), /^retry: 2000\n\n/);
  assert.equal((await sc.messages())[0].type, "snapshot");
  assert.equal((await events(req("/api/events?role=staff", { origin: null }), w.deps)).status, 401);

  const guest = await events(guestReq("/api/events?role=guest", undefined, g, { origin: null }), w.deps);
  assert.equal(guest.status, 200);
  const gc = collect(guest);
  const types = (await gc.messages()).map((m) => m.type);
  assert.deepEqual(types.slice(0, 2), ["hello", "snapshot"]);
  assert.equal(w.store.bus.count("guest"), 1);
  // Guest messages carry no scores, skeletons, counters or keys (AS-1).
  assert.doesNotMatch(await gc.text(), /"conf"|skeleton|privacy|bridgeEvents|counters|top"/);
  // Pings reach the guest stream every 2 s.
  w.tick(LIMITS.guestPingMs);
  w.store.tick();
  assert.match(await gc.text(), /\n: p\n\n|^: p\n\n|: p\n\n/);

  // End guest: session_end, the guest stream closes, the cookie is dead (401 + expiry), the staff cookie still works.
  assert.equal((await staffAction(staffReq(w, { type: "end_guest" }), w.deps)).status, 200);
  const after = await gc.messages();
  assert.equal(after[after.length - 1].type, "session_end");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(gc.ended(), true, "guest stream closed at the wipe");
  const dead = await events(guestReq("/api/events?role=guest", undefined, g, { origin: null }), w.deps);
  assert.equal(dead.status, 401);
  assert.match(dead.headers.get("set-cookie") ?? "", /^sb_g=; .*Max-Age=0/);
  assert.equal(dead.headers.get("clear-site-data"), null, "never Clear-Site-Data on the staff listener");
  assert.equal((await staffAction(staffReq(w, { type: "new_guest" }), w.deps)).status, 200, "staff still signed in");
  await sc.cancel();
});

test("SRV-19: a cancelled stream is unsubscribed; 20 reconnects leave only the open streams", async () => {
  const w = world();
  const opened: ReturnType<typeof collect>[] = [];
  for (let i = 0; i < 20; i++) {
    const c = collect(await events(req("/api/events?role=staff", { cookie: w.staffCookie, origin: null }), w.deps));
    await c.text();
    opened.push(c);
    if (i < 19) await c.cancel();
  }
  assert.equal(w.store.bus.count("staff"), 1);
  await opened[19].cancel();
  assert.equal(w.store.bus.count("staff"), 0);
});

/* ------------------------------ Help, limits, replay ------------------------------ */

test("GST-2a: Get staff now is dispatched first: text/plain, no nonce, after every limit; never 409/429; never a warning", async () => {
  const w = world();
  const g = await startGuest(w);
  for (let i = 0; i < 7; i++) await act(w, g, { type: "guest_typed", text: "hello" });
  assert.equal((await act(w, g, { type: "guest_typed", text: "hello" })).status, 429);
  const warningsBefore = JSON.stringify(w.store.warnings.map((x) => [x.kind, x.count]));
  for (let i = 0; i < 20; i++) {
    const r = await guestAction(guestReq("/api/guest/action", { type: "emergency" }, g, { ct: "text/plain", origin: null, site: null }), w.deps);
    assert.equal(r.status, 200);
  }
  assert.equal(w.store.session?.emergency?.count, 20);
  assert.equal(JSON.stringify(w.store.warnings.map((x) => [x.kind, x.count])), warningsBefore, "Help raised a safety warning");
  // Without the cookie Help gets 401 (the printed card is the independent path).
  assert.equal((await guestAction(guestReq("/api/guest/action", { type: "emergency" }, undefined), w.deps)).status, 401);
  // Security review F2: another localhost port is the same *site*, so the browser sends sb_g; Help from
  // there is refused (same-site and cross-site, foreign Origin), and no alert is raised.
  for (const o of [
    { origin: "http://localhost:3548", site: "same-site" },
    { origin: "http://evil.example", site: "cross-site" },
    { origin: "http://localhost:3548", site: null },
  ]) {
    const r = await guestAction(guestReq("/api/guest/action", { type: "emergency" }, g, { ct: "text/plain", ...o }), w.deps);
    assert.equal(r.status, 403, JSON.stringify(o));
  }
  assert.equal(w.store.session?.emergency?.count, 20, "a foreign page raised no alert");
});

test("AS-16/SES-8 (security review F1): a guest sign_control tap does not move the idle timer", async () => {
  const w = world();
  await startGuest(w);
  const s = w.store.session!;
  s.lastActivityAt = 1;
  for (const cmd of ["record", "end", "undo"] as const) w.store.noteSignControl(cmd, true);
  assert.equal(s.lastActivityAt, 1);
});

test("GST-8: a reused nonce is 409 and raises 'Repeated request'; a stale confirm too", async () => {
  const w = world();
  const g = await startGuest(w);
  const n = nonce();
  assert.equal((await guestAction(guestReq("/api/guest/action", { n, type: "heartbeat" }, g), w.deps)).status, 200);
  assert.equal((await guestAction(guestReq("/api/guest/action", { n, type: "heartbeat" }, g), w.deps)).status, 409);
  assert.ok(w.store.warnings.some((x) => x.kind === "repeated_request"));
  const r = await act(w, g, { type: "guest_confirm", proposalId: "p-gone", candidateId: "p-gone-0" });
  assert.equal(r.status, 409);
  assert.ok((w.store.warnings.find((x) => x.kind === "repeated_request")?.count ?? 0) >= 2);
  // Unknown keys, a cross-site origin and the wrong content type are refused for non-emergency actions.
  assert.equal((await act(w, g, { type: "heartbeat", extra: true })).status, 400);
  assert.equal((await act(w, g, { type: "heartbeat" }, { origin: "http://evil.example", site: "cross-site" })).status, 403);
  assert.equal((await act(w, g, { type: "heartbeat" }, { ct: "text/plain" })).status, 415);
});

test("hijack: the guest cookie from a different browser is refused and reported; Help still works", async () => {
  const w = world();
  const g = await startGuest(w);
  const r = await act(w, g, { type: "heartbeat" }, { ua: "OtherBrowser/9" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.ok(w.store.warnings.some((x) => x.kind === "device_changed"));
  assert.equal((await events(guestReq("/api/events?role=guest", undefined, g, { origin: null, ua: "OtherBrowser/9" }), w.deps)).status, 401);
  assert.equal((await act(w, g, { type: "emergency" }, { ua: "OtherBrowser/9" })).status, 200);
  assert.equal((await act(w, g, { type: "heartbeat" })).status, 200, "the real guest window keeps working");
});

/* ------------------------------ recognizer bridge ------------------------------ */

test("BRG-1: bridge key (503 unset or short, 401 wrong), no browsers, 8 KB, 10 a second", async () => {
  const w = world();
  const ev = { type: "status", recognizer: "ok" };
  assert.equal((await bridgePost(bridgeReq(ev), { ...w.deps, bridgeKey: null })).status, 503);
  assert.equal((await bridgePost(bridgeReq(ev), { ...w.deps, bridgeKey: "short" })).status, 503);
  assert.equal((await bridgePost(bridgeReq(ev, { headers: { "x-bridge-key": "c".repeat(40) } }), w.deps)).status, 401);
  assert.ok(w.store.warnings.some((x) => x.kind === "recognizer_event"));
  assert.equal((await bridgePost(bridgeReq(ev, { proof: null }), w.deps)).status, 403);
  assert.equal((await bridgePost(bridgeReq(ev, { origin: "http://127.0.0.1:3000" }), w.deps)).status, 403, "a browser page cannot post events");
  assert.equal((await bridgePost(bridgeReq(ev, { host: "evil.example" }), w.deps)).status, 403);
  assert.equal((await bridgePost(bridgeReq({ type: "status", recognizer: "ok", pad: "x".repeat(9000) }), w.deps)).status, 413);
  let limited = false;
  for (let i = 0; i < 12; i++) limited ||= (await bridgePost(bridgeReq(ev), w.deps)).status === 429;
  assert.ok(limited);
  w.tick(1_000);
  assert.equal((await bridgePost(bridgeReq(ev), w.deps)).status, 200);
});

test("BRG-2/3/4: refused body keys are counted; stale events dropped; consent gate; GET accepting", async () => {
  const w = world();
  const g = await startGuest(w);
  await recognizerUp(w);
  const before = w.store.thisGuest.refusedBodyKeys.face;
  assert.equal((await bridgePost(bridgeReq({ type: "sign", seq: 1, top: [{ label: "YES", conf: 0.9 }], face: [[0, 0]] }), w.deps)).status, 400);
  assert.equal(w.store.thisGuest.refusedBodyKeys.face, before + 1);
  assert.equal((await bridgePost(bridgeReq({ type: "sign", seq: 1, top: [{ label: "YES", conf: 0.9 }] }), w.deps)).status, 409, "guest has not chosen Sign");
  assert.equal((await body(await bridgeGet(bridgeReq(undefined), w.deps))).accepting, false);
  assert.equal((await act(w, g, { type: "guest_choice", choice: "sign" })).status, 200);
  assert.equal((await body(await bridgeGet(bridgeReq(undefined), w.deps))).accepting, true);
  const old = (T0 - 6_000) / 1000;
  assert.equal((await body(await bridgePost(bridgeReq({ type: "sign", seq: 1, top: [{ label: "YES", conf: 0.9 }], t_sent: old }), w.deps))).outcome, "stale");
  assert.equal((await body(await bridgePost(bridgeReq({ type: "sign", seq: 1, top: [{ label: "YES", conf: 0.9 }] }), w.deps))).outcome, "stored");
  assert.equal((await body(await bridgePost(bridgeReq({ type: "sign", seq: 1, top: [{ label: "YES", conf: 0.9 }] }), w.deps))).outcome, "duplicate");
  // A recognizer restart (lower seq) starts a new run and is never dropped (C1-11).
  assert.equal((await body(await bridgePost(bridgeReq({ type: "sign", seq: 3, top: [{ label: "NO", conf: 0.9 }] }), w.deps))).outcome, "stored");
  assert.equal((await body(await bridgePost(bridgeReq({ type: "sign", seq: 2, top: [{ label: "NO", conf: 0.9 }] }), w.deps))).outcome, "stored");
  assert.equal(w.store.recognizer.restarts, 1);
  // vlm_suggestion is 404 while VLM_FALLBACK is off (GST-7a).
  assert.equal((await bridgePost(bridgeReq({ type: "vlm_suggestion", seq: 1, label: "YES", conf: 0.9, model: "m" }), w.deps)).status, 404);
});

test("SPK-4: order-insensitive match with LEAVE = checkout (and the FS-CHECKOUT alias); confirm before speaking", async () => {
  const w = world();
  const g = await startGuest(w);
  await recognizerUp(w);
  await act(w, g, { type: "guest_choice", choice: "sign" });
  const sc = collect(await events(req("/api/events?role=staff", { cookie: w.staffCookie, origin: null }), w.deps));
  const send = async (ev: unknown) => body(await bridgePost(bridgeReq(ev), w.deps));
  await send({ type: "sign", seq: 1, top: [{ label: "TIME", conf: 0.92 }] });
  await send({ type: "sign", seq: 2, top: [{ label: "FS-CHECKOUT", conf: 0.9 }] });
  const u = await send({ type: "utterance", signs: [{ label: "TIME", conf: 0.92 }, { label: "FS-CHECKOUT", conf: 0.9 }], seqs: [1, 2], needs_repeat: false });
  assert.equal(u.outcome, "proposal");
  const p = w.store.session!.pending!.proposal;
  assert.equal(p.kind, "proposal");
  assert.equal(p.candidates[0].text, "What time is checkout?");
  // Nothing is voiced before the guest taps Send (SPK-1).
  const staffMsgs = async () => (await sc.messages()).map((m) => m.type);
  assert.equal((await staffMsgs()).includes("guest_utterance"), false);
  const c = await act(w, g, { type: "guest_confirm", proposalId: p.proposalId, candidateId: p.candidates[0].candidateId });
  assert.equal(c.status, 200);
  const gu = (await sc.messages()).find((m) => m.type === "guest_utterance") as { speak: { mode: string; intentId: number } } | undefined;
  assert.ok(gu);
  assert.deepEqual(gu.speak, { mode: "tts", intentId: 11, fixedText: "What time is checkout?" });
  await sc.cancel();
});

test("BRG-6: the simulator is 404 unless SB_SIMULATE=1, needs the staff cookie, and labels its signs", async () => {
  const off = world({ simulate: false });
  assert.equal((await simulate(req("/api/dev/simulate", { cookie: off.staffCookie, body: { type: "status", recognizer: "ok" } }), off.deps)).status, 404);
  const w = world();
  assert.equal((await simulate(req("/api/dev/simulate", { body: { type: "status", recognizer: "ok" } }), w.deps)).status, 401);
  const g = await startGuest(w);
  assert.equal((await simulate(req("/api/dev/simulate", { cookie: w.staffCookie, body: { type: "status", recognizer: "ok" } }), w.deps)).status, 200);
  await act(w, g, { type: "guest_choice", choice: "sign" });
  const gc = collect(await events(guestReq("/api/events?role=guest", undefined, g, { origin: null }), w.deps));
  await gc.text();
  assert.equal((await simulate(req("/api/dev/simulate", { cookie: w.staffCookie, body: { type: "sign", seq: 1, top: [{ label: "YES", conf: 0.9 }] } }), w.deps)).status, 200);
  const live = (await gc.messages()).find((m) => m.type === "live_sign") as { simulated: boolean } | undefined;
  assert.equal(live?.simulated, true);
  await gc.cancel();
});

/* ------------------------------ timers and wipe ------------------------------ */

test("SES-8/9: only staff actions and accepted signs move the idle timer; the cap fires while busy; Extend is staff-only", async () => {
  const w = world({ idleWipeMs: 60_000, idleWipeUnconfirmedMs: 60_000, sessionCapMs: 5 * 60_000 });
  const g = await startGuest(w);
  w.tick(40_000);
  for (const a of [{ type: "heartbeat" }, { type: "prefs", speakAloud: false }, { type: "guest_typed", text: "hi" }]) await act(w, g, a);
  w.tick(15_000);
  w.store.tick();
  assert.ok(w.store.session, "idle warning only so far");
  w.tick(6_000);
  w.store.tick();
  assert.equal(w.store.session, null, "guest actions did not keep the session alive");
  assert.equal(w.store.lastWipe?.reason, "idle");

  const g2 = await startGuest(w);
  for (let i = 0; i < 5; i++) {
    w.tick(50_000);
    assert.equal((await staffAction(staffReq(w, { type: "touch" }), w.deps)).status, 200);
    w.store.tick();
  }
  assert.ok(w.store.session, "staff Keep open resets the idle timer");
  assert.equal((await act(w, g2, { type: "extend" })).status, 400, "a guest cannot extend");
  w.tick(50_000);
  await staffAction(staffReq(w, { type: "touch" }), w.deps);
  w.store.tick();
  assert.equal(w.store.session, null, "the cap fired although staff were active");
  assert.equal(w.store.lastWipe?.reason, "cap");

  const g3 = await startGuest(w);
  void g3;
  assert.equal((await staffAction(staffReq(w, { type: "extend" }), w.deps)).status, 409, "Extend only in the last 2 minutes");
  w.tick(3 * 60_000 + 1);
  await staffAction(staffReq(w, { type: "touch" }), w.deps);
  assert.equal((await staffAction(staffReq(w, { type: "extend" }), w.deps)).status, 200);
  assert.equal(w.store.status().session.extensions, 1);
});

test(`SES-10: the wipe erases names and typed text (${CANARY}); the canary never reaches a TTS plan or a vendor`, async () => {
  const w = world();
  const g = await startGuest(w);
  await recognizerUp(w);
  const sc = collect(await events(req("/api/events?role=staff", { cookie: w.staffCookie, origin: null }), w.deps));
  await act(w, g, { type: "guest_choice", choice: "type" });
  assert.equal((await act(w, g, { type: "guest_phrase", intentId: 4, name: NAME_CANARY })).status, 200);
  assert.equal((await act(w, g, { type: "guest_typed", text: `my room key ${CANARY}` })).status, 200);
  await staffAction(staffReq(w, { type: "say_text", text: `Hello ${CANARY}`, gloss: null, source: "typed" }), w.deps);
  const msgs = await sc.messages();
  const plans = msgs.filter((m) => m.type === "guest_utterance").map((m) => m.speak as { mode: string });
  assert.deepEqual(plans, [{ mode: "local_after_tap", tap: "speak_name" }], "the name waits for Speak name and never goes to /api/tts");
  assert.ok(JSON.stringify(w.store).includes(CANARY));
  assert.ok(JSON.stringify(w.store).includes(NAME_CANARY));
  assert.equal(JSON.stringify(plans).includes(NAME_CANARY), false);
  const before = w.store.thisGuest.vendorCalls.length;
  assert.equal((await staffAction(staffReq(w, { type: "end_guest" }), w.deps)).status, 200);
  assert.equal(JSON.stringify(w.store).includes(CANARY), false, "canary survived the wipe");
  assert.equal(JSON.stringify(w.store).includes(NAME_CANARY), false, "name survived the wipe");
  assert.equal(w.store.lastWipe?.reason, "staff_ended");
  assert.ok((w.store.lastWipe?.itemsErased ?? 0) > 3);
  assert.equal(before, 0, "no vendor call in the offline configuration");
  await sc.cancel();
});

test("SES-12: the guest's I'm finished ends the session; leave expires sb_g without Clear-Site-Data; the staff cookie survives", async () => {
  const w = world();
  const g = await startGuest(w);
  const r = await guestLeave(guestReq("/api/guest/leave", undefined, g), w.deps);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie") ?? "", /^sb_g=; HttpOnly; SameSite=Strict; Path=\/; Max-Age=0$/);
  assert.equal(r.headers.get("clear-site-data"), null);
  assert.equal(w.store.lastWipe?.reason, "guest_left");
  assert.equal((await staffAction(staffReq(w, { type: "new_guest" }), w.deps)).status, 200);
  // A leave with a dead cookie is still 200 and still expires it.
  assert.equal((await guestLeave(guestReq("/api/guest/leave", undefined, g), w.deps)).status, 200);
});

test("DSH-5: privacy counters move only with real deliveries and real vendor taps", async () => {
  const w = world();
  assert.equal(w.store.thisGuest.messagesToGuest, 0);
  const g = await startGuest(w);
  await staffAction(staffReq(w, { type: "say_quick", intent: "welcome" }), w.deps);
  assert.equal(w.store.thisGuest.messagesToGuest, 0, "no guest stream open: nothing delivered");
  const gc = collect(await events(guestReq("/api/events?role=guest", undefined, g, { origin: null }), w.deps));
  await gc.text();
  const after = w.store.thisGuest.messagesToGuest;
  assert.equal(after, 3, "hello, snapshot and the caption badge (features-plan F3)");
  await staffAction(staffReq(w, { type: "say_quick", intent: "room_number" }), w.deps);
  assert.equal(w.store.thisGuest.messagesToGuest, 4);
  w.store.noteVendorTaps([{ route: "/api/tts", bytes: 120 }]);
  assert.equal(w.store.thisGuest.vendorCalls[0].count, 1);
  assert.equal(w.store.thisGuest.guestBytesOffLaptop, 120);
  await gc.cancel();
});
