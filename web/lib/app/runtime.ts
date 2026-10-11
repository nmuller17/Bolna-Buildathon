// SignBridge app (P4, builder A): process wiring for the store (docs/app-plan.md 10, SRV-19).
//
// Route handlers are bundled per route, so a module-level store would be duplicated per route chunk.
// The one store, its bus and its one sweeper therefore live on globalThis[Symbol.for("signbridge.store.v2")];
// the sweeper starts once behind a globalThis flag, so a route chunk or a dev hot reload never adds a
// second one. This file reads the environment and signs/index.json once; all logic is in store.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { RateLimiter } from "./access.ts";
import type { RouteDeps } from "./routes.ts";
import { claimCapability, isStaffToken } from "./staffcap.ts";
import { defaultConfig, Store, type StoreConfig } from "./store.ts";
import { drainVendorTaps } from "./taps.ts";
import { LIMITS, SESSION_PROFILES, type SessionProfile, type SignControlCmd, type VriInfo } from "./types.ts";

const STORE_KEY = Symbol.for("signbridge.store.v2");
const SWEEPER_KEY = Symbol.for("signbridge.sweeper.v2");
const SWEEP_MS = 500;

type Env = Record<string, string | undefined>;

const flag = (v: string | undefined) => v === "1";
function posInt(v: string | undefined, min: number, max: number): number | null {
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}
const clean = (v: string | undefined, max: number): string | null => {
  const s = (v ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  return s && s.length <= max ? s : null;
};

/** VRI details from VRI_* (not secret). A link only over https; a contact always labelled by its kind. */
export function vriFromEnv(env: Env): VriInfo {
  const label = clean(env.VRI_LABEL, 80);
  const urlRaw = clean(env.VRI_URL, 300);
  let url: string | null = null;
  if (urlRaw) {
    try {
      const u = new URL(urlRaw);
      if (u.protocol === "https:") url = u.toString();
    } catch {
      url = null;
    }
  }
  const kind = env.VRI_CONTACT_KIND === "videophone" || env.VRI_CONTACT_KIND === "text" ? env.VRI_CONTACT_KIND : null;
  const value = clean(env.VRI_CONTACT, 80);
  return { label, url, contact: kind && value ? { kind, value } : null };
}

/** The store configuration from the environment (plan 14 item 11). Pure, so it can be tested. */
export function configFromEnv(env: Env, knownSigns: ReadonlySet<string>): StoreConfig {
  const profile: SessionProfile = env.SB_PROFILE === "stage" ? "stage" : "engagement";
  const p = SESSION_PROFILES[profile];
  // IDLE_WIPE_MS and SESSION_CAP_MS override the profile (for rehearsal and tests); 1 s to 4 h.
  const idle = posInt(env.IDLE_WIPE_MS, 1_000, 4 * 3_600_000);
  const cap = posInt(env.SESSION_CAP_MS, 1_000, 4 * 3_600_000);
  const vendorKeysConfigured = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY"].filter((k) => (env[k] ?? "").trim() !== "");
  return defaultConfig({
    profile,
    mode0GuestInputRequested: flag(env.MODE0_GUEST_INPUT),
    idleWipeMs: idle ?? p.idleWipeMs,
    idleWipeUnconfirmedMs: idle ?? p.idleWipeUnconfirmedMs,
    sessionCapMs: cap ?? p.sessionCapMs,
    port: posInt(env.PORT, 1, 65_535) ?? 3000,
    simulate: flag(env.SB_SIMULATE),
    vlmFallback: flag(env.VLM_FALLBACK),
    englishFallback: flag(env.ENGLISH_FALLBACK),
    bridgeKeyConfigured: (env.BRIDGE_KEY ?? "").length >= LIMITS.bridgeKeyMinLen,
    transcribeAvailable: (env.OPENAI_API_KEY ?? "").trim() !== "",
    ttsAvailable: (env.ELEVENLABS_API_KEY ?? "").trim() !== "" || env.PIPER_FALLBACK === "1",
    vendorKeysConfigured,
    vri: vriFromEnv(env),
    emergencyNote: clean(env.EMERGENCY_NOTE, 200) ?? "This app does not call 911.",
    knownSigns,
    signControlPort: posInt(env.LIVE_KEY_CONTROL_PORT, 1_024, 65_535),
  });
}

function loadKnownSigns(): Set<string> {
  try {
    const index = JSON.parse(readFileSync(path.join(process.cwd(), "..", "signs", "index.json"), "utf8")) as Record<string, string>;
    return new Set(Object.keys(index));
  } catch {
    return new Set();
  }
}

/** The process-wide store. Created on first use; the sweeper starts once. */
export function getStore(): Store {
  const g = globalThis as unknown as Record<symbol, unknown>;
  let store = g[STORE_KEY] as Store | undefined;
  if (!store) {
    store = new Store(configFromEnv(process.env, loadKnownSigns()));
    g[STORE_KEY] = store;
  }
  if (!g[SWEEPER_KEY]) {
    const s = store;
    let probing = false;
    let lastProbe = 0;
    const timer = setInterval(() => {
      try {
        s.noteVendorTaps(drainVendorTaps());
        s.tick();
        const port = s.config.signControlPort;
        if (port !== null && !probing && Date.now() - lastProbe >= CONTROL_PROBE_MS) {
          probing = true;
          lastProbe = Date.now();
          controlRequest(port, "GET", "/health")
            .then((up) => s.noteControlHealth(up))
            .finally(() => {
              probing = false;
            });
        }
      } catch {
        // A sweeper error must never take the server down; the next tick tries again.
      }
    }, SWEEP_MS);
    timer.unref?.();
    g[SWEEPER_KEY] = timer;
  }
  return store;
}

const CONTROL_PROBE_MS = 1_000;
const CONTROL_PATH: Record<SignControlCmd, string> = { record: "/sign", undo: "/undo", end: "/end" };

/**
 * One request to live_key.py --control-port, on 127.0.0.1 only (the port comes from the environment,
 * the path from a fixed table; no body, no redirects, 1 s timeout). True when it answered 200.
 */
async function controlRequest(port: number, method: "GET" | "POST", p: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, redirect: "manual", signal: AbortSignal.timeout(1_000), body: method === "POST" ? "" : undefined });
    await res.arrayBuffer().catch(() => null);
    return res.status === 200;
  } catch {
    return false;
  }
}

const LIMITERS_KEY = Symbol.for("signbridge.routelimiters.v2");

function limit(name: string, max: number, windowMs: number): boolean {
  const g = globalThis as unknown as Record<symbol, Map<string, RateLimiter> | undefined>;
  const m = (g[LIMITERS_KEY] ??= new Map());
  let l = m.get(name);
  if (!l) {
    l = new RateLimiter(max, windowMs);
    m.set(name, l);
  }
  return l.take();
}

function readBenchmark(): unknown {
  const file = process.env.BENCHMARK_CLEARED_FILE;
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(path.resolve(file), "utf8"));
  } catch {
    return null;
  }
}

/** What every app route handler needs, from the environment that web/server.mjs prepared. */
export function routeDeps(): RouteDeps {
  const store = getStore();
  return {
    store,
    port: store.config.port,
    proof: process.env.SB_PROOF || null,
    bridgeKey: process.env.BRIDGE_KEY || null,
    simulate: store.config.simulate,
    limit,
    staff: { isToken: isStaffToken, claim: claimCapability },
    readBenchmark,
    signControl: (cmd) => {
      const port = store.config.signControlPort;
      return port === null ? Promise.resolve(false) : controlRequest(port, "POST", CONTROL_PATH[cmd]);
    },
  };
}
