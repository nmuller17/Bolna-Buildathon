"use client";
// P4 (builder B): the staff screen's right column (check-in co-pilot) and bottom tabs (plan 4.2):
// Evidence, Latency, Privacy, Benchmark, Simulator, Safety and Device. Every number shown comes
// from the server's real counters or real timestamps; nothing here is estimated or hard-coded.
import { useEffect, useRef, useState } from "react";
import { KeyTag, SimulatedBadge, TrafficLight } from "@/components/app/KeyTag";
import { GUEST_PHRASES } from "@/components/app/displayVocab";
import { postJson } from "@/lib/channel";
import {
  CHECKIN_ITEMS,
  CHECKLIST_NOTE,
  EVIDENCE_NOTE,
  PRIVACY_DISK_NOTE,
  type BenchmarkResponse,
  type BridgeEvent,
  type CheckinItemStatus,
  type FramingStatus,
  type PrivacyCounters,
  type SignLabel,
} from "@/lib/app/types";
import type { Desk, EvidenceItem } from "./useStaffDesk";
import s from "./staff.module.css";

/** Desk clock, 24-hour, so a log column never wraps: "10:02" or "10:02:41". */
export const clock = (ms: number | null, seconds = false) =>
  ms === null ? "—" : new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });

const clockMs = (unixSeconds: number | null) => {
  if (unixSeconds === null) return "—";
  const d = new Date(unixSeconds * 1000);
  return `${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.${String(d.getMilliseconds()).padStart(3, "0").slice(0, 2)}`;
};

/* ------------------------------------------------------------------ */
/* Check-in co-pilot (DSH-2)                                           */
/* ------------------------------------------------------------------ */

export function Checklist({ desk }: { desk: Desk }) {
  const { ui, staffAction } = desk;
  const byKey = new Map<string, CheckinItemStatus>(ui.checklist.map((c) => [c.key, c]));
  return (
    <section className={s.column} aria-labelledby="copilot-title">
      <h2 id="copilot-title" className={s.colTitle}>
        Check-in co-pilot
      </h2>
      <p className={s.copilotNote}>{CHECKLIST_NOTE}</p>
      <ul className={s.checklist}>
        {CHECKIN_ITEMS.map((def) => {
          const st = byKey.get(def.key);
          const state = st?.state ?? "not_shared";
          const askedOpen = st?.guestAskedAt && state !== "shared";
          return (
            <li key={def.key} className={s.checkItem} data-state={state}>
              <span className={s.checkMark} data-state={state} aria-hidden="true">
                {state === "needs_retry" ? "?" : ""}
              </span>
              <span className={s.checkBody}>
                <span className={s.checkLabel}>{def.label}</span>
                <span className={s.checkState}>
                  {state === "shared" && `shared ${clock(st!.at)}`}
                  {state === "sent" && "sent, not shown on the guest screen yet"}
                  {state === "needs_retry" && "needs another try (the guest asked for a repeat)"}
                  {state === "not_shared" && (def.manual && st?.seenByStaff ? "seen by staff" : def.key === "anything_else" ? "not asked yet" : "not shared yet")}
                </span>
                {askedOpen && <span className={s.checkAsked}>Guest asked {clock(st!.guestAskedAt)}; not answered yet</span>}
              </span>
              {def.manual && !st?.seenByStaff && (
                <button type="button" className={s.small} disabled={ui.sessionState === "NO_SESSION"} onClick={() => void staffAction({ type: "checklist_seen", item: def.key })}>
                  I saw it
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className={s.hint}>Gentle reminders only; nothing here blocks the conversation.</p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Bottom tabs                                                         */
/* ------------------------------------------------------------------ */

export type TabKey = "evidence" | "latency" | "privacy" | "benchmark" | "simulator" | "safety" | "device";

type TabsProps = { desk: Desk; tab: TabKey; setTab: (t: TabKey) => void; open: boolean; setOpen: (v: boolean) => void };

/** The details drawer under the columns. WAI-ARIA tabs: arrow keys move between tabs, Home and End jump. */
export function BottomTabs({ desk, tab, setTab, open, setOpen }: TabsProps) {
  const sim = desk.ui.status?.flags.simulateEnabled ?? false;
  const openWarnings = desk.ui.warnings.filter((w) => w.open).length;
  const tabs: { key: TabKey; label: string }[] = [
    { key: "evidence", label: "Evidence" },
    { key: "latency", label: "Latency" },
    { key: "privacy", label: "Privacy" },
    { key: "benchmark", label: "Benchmark" },
    ...(sim ? [{ key: "simulator" as const, label: "Simulator" }] : []),
    { key: "safety", label: `Safety${openWarnings ? ` (${openWarnings})` : ""}` },
    { key: "device", label: "Device" },
  ];
  const current = tabs.some((t) => t.key === tab) ? tab : "evidence";
  const listRef = useRef<HTMLDivElement>(null);

  const onKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.key === current);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next === -1) return;
    e.preventDefault();
    setTab(tabs[next].key);
    setOpen(true);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <section className={s.tabs} aria-label="Details" data-open={open || undefined}>
      <div className={s.tabBar}>
        <div role="tablist" aria-label="Details" className={s.tabList} ref={listRef} onKeyDown={onKey}>
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              id={`tab-${t.key}`}
              aria-selected={current === t.key}
              aria-controls="details-panel"
              tabIndex={current === t.key ? 0 : -1}
              className={s.tab}
              onClick={() => {
                setTab(t.key);
                setOpen(true);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button type="button" className={s.drawerToggle} aria-expanded={open} aria-controls="details-panel" onClick={() => setOpen(!open)}>
          {open ? "Hide details" : "Show details"}
        </button>
      </div>
      <div role="tabpanel" id="details-panel" aria-labelledby={`tab-${current}`} className={s.tabPanel} hidden={!open} tabIndex={0}>
        {current === "evidence" && <Evidence items={desk.ui.evidence} />}
        {current === "latency" && <Latency desk={desk} />}
        {current === "privacy" && <Privacy desk={desk} />}
        {current === "benchmark" && <Benchmark />}
        {current === "simulator" && sim && <Simulator desk={desk} />}
        {current === "safety" && <Safety desk={desk} />}
        {current === "device" && <DevicePanel desk={desk} />}
      </div>
    </section>
  );
}

const PRESSURE_WORDS = { nominal: "normal", fair: "busy", serious: "very busy", critical: "overloaded" } as const;

/** Tier 2 slot: shows a load state only when a team-owned device's browser reported one (C2-8). */
function DevicePanel({ desk }: { desk: Desk }) {
  const h = desk.ui.status?.deviceHealth;
  const line = (who: string, v: { state: keyof typeof PRESSURE_WORDS | null; at: number | null } | undefined) =>
    v && v.state ? `${who}: ${PRESSURE_WORDS[v.state]} (reported ${clock(v.at, true)})` : `${who}: not available`;
  return (
    <div className={s.panelBody}>
      <p>{line("Guest device", h?.guest)}</p>
      <p>{line("This laptop", h?.staff)}</p>
      <p className={s.hint}>This only reflects how busy a device is, where its browser can report it. It is not a security check.</p>
    </div>
  );
}

/**
 * The skeleton snapshot (plan 6.2) as dots and lines: shoulders, arms and hands, no face. Coordinates
 * are the recognizer's normalized x/y (y down). Drawn only on the staff screen; never sent to the guest.
 */
function SkeletonSketch({ sk }: { sk: NonNullable<EvidenceItem["sign"]["skeleton"]> }) {
  const pts = [...sk.pose, ...(sk.lh ?? []), ...(sk.rh ?? [])];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 0.05);
  const pad = span * 0.12;
  const vb = `${minX - pad} ${minY - pad} ${span + pad * 2} ${span + pad * 2}`;
  const P = sk.pose;
  // pose order: 0 nose (shown only as the neck anchor), 11 L shoulder, 12 R shoulder, 13 L elbow, 14 R elbow, 15 L wrist, 16 R wrist
  const bones: [number, number][] = [[1, 2], [1, 3], [3, 5], [2, 4], [4, 6]];
  const hand = (h: [number, number][] | null) =>
    h ? [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]].map((f) => f.map((i) => h[i]).filter(Boolean)) : [];
  const w = span / 90;
  return (
    <svg className={s.skeleton} viewBox={vb} role="img" aria-label="Skeleton snapshot: shoulders, arms and hands, no face">
      {bones.map(([a, b], i) =>
        P[a] && P[b] ? <line key={i} x1={P[a][0]} y1={P[a][1]} x2={P[b][0]} y2={P[b][1]} stroke="currentColor" strokeWidth={w * 2.2} strokeLinecap="round" /> : null,
      )}
      {[...hand(sk.lh), ...hand(sk.rh)].map((f, i) => (
        <polyline key={`f${i}`} points={f.map((p) => `${p[0]},${p[1]}`).join(" ")} fill="none" stroke="var(--brass-dark)" strokeWidth={w * 1.2} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {P.slice(1).map((p, i) => (
        <circle key={`p${i}`} cx={p[0]} cy={p[1]} r={w * 2.2} fill="currentColor" />
      ))}
    </svg>
  );
}

function Evidence({ items }: { items: EvidenceItem[] }) {
  const list = [...items].reverse();
  return (
    <div className={s.panelBody}>
      <p className={s.evidenceNote}>{EVIDENCE_NOTE}</p>
      {list.length === 0 && <p className={s.hint}>No signs recognised for this guest yet. Evidence never includes video.</p>}
      <ol className={s.evidenceList}>
        {list.map(({ sign, simulated }, i) => {
          const top = sign.top[0];
          const delay = sign.tPredicted !== null && sign.tSignEnd !== null ? `${(sign.tPredicted - sign.tSignEnd).toFixed(2)} s` : "—";
          return (
            <li key={`${sign.seq}-${sign.receivedAt}-${i}`} className={s.evidenceRow}>
              <span className={s.evSeq}>#{sign.seq ?? "?"}</span>
              <KeyTag token={top?.label ?? "NONE"} small missed={sign.light === "red"} />
              <TrafficLight light={sign.light} surface="staff" red={sign.red} />
              <span>
                {top ? top.conf.toFixed(2) : "—"} <span className={s.hint}>model score (uncalibrated), bar {sign.bar.toFixed(2)}</span>
              </span>
              <span className={s.hint}>
                moved {clockMs(sign.tSignStart)} to {clockMs(sign.tSignEnd)}, predicted +{delay}
              </span>
              <span className={s.hint}>
                {sign.joined && sign.top.length > 1
                  ? `alternatives ${sign.top
                      .slice(1)
                      .map((p) => `${p.label} ${p.conf.toFixed(2)}`)
                      .join(", ")}`
                  : "top-1 only: the sign event did not arrive"}
              </span>
              {sign.skeleton ? (
                <span className={s.skeletonCell}>
                  <SkeletonSketch sk={sign.skeleton} />
                  <span className={s.hint}>skeleton snapshot, memory only, no face</span>
                </span>
              ) : (
                <span className={s.hint}>skeleton: none from this recognizer build</span>
              )}
              {simulated && <SimulatedBadge />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const ms = (v: number | null) => (v === null ? "no data yet" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);

function Latency({ desk }: { desk: Desk }) {
  const stages = desk.ui.status?.latency ?? [];
  return (
    <div className={s.panelBody}>
      <p className={s.hint}>Measured from real timestamps for this guest. Stages with no data say so; nothing is estimated.</p>
      <table className={s.table}>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Last</th>
            <th scope="col">Median</th>
            <th scope="col">Count</th>
            <th scope="col">Measured by</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((st) => (
            <tr key={st.key}>
              <th scope="row">{st.label}</th>
              <td>{st.count ? ms(st.lastMs) : "no data yet"}</td>
              <td>{st.count ? ms(st.medianMs) : "—"}</td>
              <td>{st.count}</td>
              <td>{st.measuredBy === "guest_device" ? "reported by the guest device (round trip)" : "this laptop"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {stages.length === 0 && <p className={s.hint}>no data yet</p>}
    </div>
  );
}

function bytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function PrivacyColumn({ title, c }: { title: string; c: PrivacyCounters }) {
  const refused = c.refusedBodyKeys;
  return (
    <div className={s.privacyCol}>
      <h3 className={s.subTitle}>{title}</h3>
      <dl className={s.dl}>
        <dt>Vendor calls made by the SignBridge server</dt>
        <dd>
          {c.vendorKeysConfigured.length === 0 && c.vendorCalls.length === 0
            ? "0 (no vendor keys configured: none possible)"
            : c.vendorCalls.length === 0
              ? "0"
              : c.vendorCalls.map((v) => `${v.destination}: ${v.count} (${bytes(v.bytesSent)}${v.guestData ? ", guest data" : ""})`).join("; ")}
        </dd>
        <dt>Guest-derived data off the laptop</dt>
        <dd>{bytes(c.guestBytesOffLaptop)}</dd>
        <dt>Sent to the guest screen</dt>
        <dd>
          {c.messagesToGuest} messages, {bytes(c.bytesToGuest)}
        </dd>
        <dt>Recognizer events accepted</dt>
        <dd>{c.bridgeEvents} (labels and timestamps only)</dd>
        <dt>Events refused for carrying body data</dt>
        <dd>
          face {refused.face}, frames {refused.frames}, pose {refused.pose}, video {refused.video}
        </dd>
        <dt>Skeleton snapshots in memory</dt>
        <dd>{c.skeletonsHeld}</dd>
        <dt>Fixed sentences sent to the voice</dt>
        <dd>{c.ttsFixedSentences}</dd>
      </dl>
    </div>
  );
}

function Privacy({ desk }: { desk: Desk }) {
  const p = desk.ui.status?.privacy;
  if (!p) return <p className={s.hint}>Waiting for the desk server.</p>;
  return (
    <div className={s.panelBody}>
      <div className={s.privacyGrid}>
        <PrivacyColumn title="This guest" c={p.thisGuest} />
        <PrivacyColumn title="Since the server started" c={p.sinceStart} />
      </div>
      <dl className={s.dl}>
        <dt>Vendor keys on this laptop</dt>
        <dd>{p.sinceStart.vendorKeysConfigured.length ? p.sinceStart.vendorKeysConfigured.join(", ") : "none"}</dd>
        <dt>Session data wiped</dt>
        <dd>{p.lastWipe ? `yes, ${clock(p.lastWipe.at, true)}: ${p.lastWipe.itemsErased} items erased` : "no wipe yet"}</dd>
      </dl>
      <p className={s.diskNote}>{PRIVACY_DISK_NOTE}</p>
    </div>
  );
}

function Benchmark() {
  const [data, setData] = useState<BenchmarkResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch("/api/staff/benchmark", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<BenchmarkResponse>) : Promise.reject()))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);
  // Only a cleared, audited report may show numbers (DSH-6). Anything else is "not yet audited".
  if (!data || data.status !== "cleared") {
    return (
      <div className={s.panelBody}>
        <p className={s.benchmarkEmpty}>Accuracy figures: not yet audited.</p>
        <p className={s.hint}>
          {failed ? "The benchmark report could not be read, so no figure is shown." : "No figure is shown until an audited report is marked cleared."}
        </p>
      </div>
    );
  }
  return (
    <div className={s.panelBody}>
      <p className={s.hint}>
        Audited report {data.auditRef}, cleared {data.clearedAt}. Only the figures in that report are shown.
      </p>
      <dl className={s.dl}>
        {data.figures.map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd>
              {f.value}
              {f.n !== undefined && ` (n = ${f.n})`}
              {f.scope && `, ${f.scope}`}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Safety({ desk }: { desk: Desk }) {
  const { ui, staffAction } = desk;
  const open = ui.warnings.filter((w) => w.open);
  return (
    <div className={s.panelBody}>
      {open.length === 0 ? (
        <p className={s.hint}>No session warnings. Help presses and the guest&apos;s own choices never appear here.</p>
      ) : (
        <>
          <ul className={s.warnList}>
            {open.map((w) => (
              <li key={w.id}>
                <span>
                  {clock(w.at)} {w.text}
                  {w.count > 1 && ` (${w.count} times)`}
                </span>
                <button type="button" className={s.small} onClick={() => void staffAction({ type: "dismiss_warning", id: w.id })}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
          <p className={s.responseCard}>
            Go to the guest in person first. Then press End guest. If the guest is still there, start again with New guest and check the new number with them.
          </p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Simulator (plan 6.7): declared rehearsal, labelled SIMULATED         */
/* ------------------------------------------------------------------ */

const ALT: SignLabel[] = ["MORE", "TOWEL", "WHERE", "TIME", "PLEASE", "ROOM", "NONE"];

function Simulator({ desk }: { desk: Desk }) {
  const seqRef = useRef(0);
  const [shuffle, setShuffle] = useState(false);
  const [weak, setWeak] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const post = async (ev: BridgeEvent) => {
    const { status, data } = await postJson<{ outcome?: string; message?: string }>("/api/dev/simulate", ev);
    if (status === 409) setResult("Refused: the guest has not chosen Sign, or no session is active.");
    else if (status !== 200) setResult(`The simulator answered ${status}${data?.message ? `: ${data.message}` : ""}.`);
    else setResult(`Sent; outcome: ${data?.outcome ?? "ok"}.`);
    return status;
  };

  const now = () => Date.now() / 1000;
  const top3 = (label: SignLabel, conf: number) => {
    const others = ALT.filter((l) => l !== label);
    const rest = Math.max(0, 1 - conf);
    return [
      { label, conf },
      { label: others[0], conf: +(rest * 0.65).toFixed(3) },
      { label: others[1], conf: +(rest * 0.25).toFixed(3) },
    ];
  };
  const signEvent = (label: SignLabel, conf: number): BridgeEvent & { type: "sign" } => {
    const t = now();
    seqRef.current += 1;
    return { type: "sign", seq: seqRef.current, top: top3(label, conf), t_sign_start: t - 0.95, t_sign_end: t - 0.2, t_closed: t - 0.12, t_predicted: t - 0.04, t_sent: t };
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Sends one sign event per label, then the utterance, exactly as live.py would. */
  const utter = async (labels: SignLabel[], confs: number[], opts: { dropIndex?: number } = {}) => {
    const seqs: number[] = [];
    const signs: { label: string; conf: number }[] = [];
    for (let i = 0; i < labels.length; i++) {
      const ev = signEvent(labels[i], confs[i]);
      seqs.push(ev.seq);
      signs.push({ label: labels[i], conf: confs[i] });
      if (opts.dropIndex === i) continue; // "Drop a sign event": the utterance still names it
      if ((await post(ev)) !== 200) return;
      await pause(250);
    }
    const t = now();
    await post({ type: "utterance", signs, seqs, needs_repeat: confs.some((c, i) => c < 0.6 || labels[i] === "NONE"), t_end: t - 0.05, t_sent: t });
  };

  const intent = (signs: SignLabel[]) => {
    const order = shuffle ? [...signs].reverse() : signs;
    const confs = order.map(() => 0.9);
    if (weak) confs[Math.min(1, confs.length - 1)] = 0.45;
    return utter(order, confs);
  };

  const framing = (status: FramingStatus) => post({ type: "framing", status, since: now(), t_sent: now() });
  const recognizer = (mode: "ok" | "mock" | "no_model") => post({ type: "status", fps: 27, recognizer: mode, t: now(), t_sent: now() });

  return (
    <div className={s.panelBody}>
      <p className={s.hint}>
        Rehearsal only. Every simulated sign shows a SIMULATED badge on both screens; say so out loud if it is used on stage.
      </p>
      <div className={s.simGrid}>
        {GUEST_PHRASES.map((p) => (
          <button key={p.id} type="button" className={s.small} onClick={() => void intent(p.signs)}>
            {p.id}. {p.signs.join(" ")}
          </button>
        ))}
      </div>
      <div className={s.row}>
        <label className={s.inlineCheck}>
          <input type="checkbox" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} /> Shuffle order
        </label>
        <label className={s.inlineCheck}>
          <input type="checkbox" checked={weak} onChange={(e) => setWeak(e.target.checked)} /> Make one sign weak (0.45)
        </label>
      </div>
      <div className={s.simGrid}>
        <button type="button" className={s.small} onClick={() => void utter(["HELP", "PLEASE"], [0.5, 0.9])}>
          Low HELP
        </button>
        <button type="button" className={s.small} onClick={() => void utter(["HELP"], [0.92])}>
          Lone HELP
        </button>
        <button
          type="button"
          className={s.small}
          onClick={async () => {
            await utter(["WHERE"], [0.9]);
            await pause(2000);
            await utter(["ELEVATOR"], [0.9]);
          }}
        >
          Split utterance
        </button>
        <button type="button" className={s.small} onClick={() => void utter(["NONE"], [0.85])}>
          Reach to tap
        </button>
        <button type="button" className={s.small} onClick={() => void utter(["MORE", "TOWEL", "PLEASE"], [0.9, 0.45, 0.9], { dropIndex: 1 })}>
          Drop a sign event
        </button>
        <button
          type="button"
          className={s.small}
          onClick={() => {
            seqRef.current = 0;
            setResult("Next sign starts again at seq 1 (a recognizer restart).");
          }}
        >
          Restart recognizer
        </button>
        <button type="button" className={s.small} onClick={() => void framing("STEP_BACK")}>
          Framing: step back
        </button>
        <button type="button" className={s.small} onClick={() => void framing("OK")}>
          Framing: OK
        </button>
        <button type="button" className={s.small} onClick={() => void recognizer("mock")}>
          Recognizer in mock mode
        </button>
        <button type="button" className={s.small} onClick={() => void recognizer("no_model")}>
          Recognizer: no model
        </button>
        <button type="button" className={s.small} onClick={() => void recognizer("ok")}>
          Recognizer: ok
        </button>
      </div>
      {result && (
        <p className={s.hint} role="status">
          {result}
        </p>
      )}
      {desk.ui.sessionState !== "ACTIVE" && <p className={s.hint}>Start a guest and open the guest window first.</p>}
    </div>
  );
}
