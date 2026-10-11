"use client";
// P4: staff-side Privacy and Latency panels (BN-2). Every number comes from a real counter or timestamp:
// - Privacy: GET /api/trust (requests this server sent off the laptop, guest items held, last wipe).
//   "Face points passed to the classifier" is a property of the recognizer, stated with its source, not measured.
// - Latency: the sign events' own timestamps (recognizer t_sign_end / t_predicted, app `at`) and the time the
//   staff page painted the sign. A stage with no data says so; nothing is estimated.
import { useCallback, useEffect, useRef, useState } from "react";
import type { EgressEntry, EgressSnapshot } from "@/lib/app/egress";
import { emptyLatency, latencyStages, recordSign, type LatencyStage } from "@/lib/app/latency";
import type { GuestSign } from "@/components/useGuestEvents";
import styles from "./trustPanels.module.css";

const POLL_MS = 3000;

/** What each known destination receives, so staff can read the counter. Unknown hosts are shown as they are. */
const KNOWN: Record<string, string> = {
  "api.anthropic.com": "Anthropic Claude, from /api/english: the guest's recognized sign labels, when no known sentence matched",
  "api.elevenlabs.io": "ElevenLabs, from /api/tts: the text spoken aloud (the guest's sentence)",
  "api.openai.com": "OpenAI Whisper, from /api/transcribe: the receptionist's recorded speech",
};

type Trust = { egress: EgressSnapshot; heldItems: number };

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const total = (list: EgressEntry[]) => list.reduce((n, e) => n + e.calls, 0);
const ms = (v: number | null) => (v === null ? "no data yet" : `${v} ms`);

/** Latency from sign events. Pass `record` to useGuestEvents as onSign. */
export function useSignLatency() {
  const data = useRef(emptyLatency());
  const [stages, setStages] = useState<LatencyStage[]>(() => latencyStages(emptyLatency()));
  const [seen, setSeen] = useState({ signs: 0, timed: 0 });

  const record = useCallback((sign: GuestSign) => {
    // Two animation frames after the event: React has rendered the sign and the browser has painted it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (document.visibilityState !== "visible") return; // a hidden page shows nothing: no "shown" time
        recordSign(data.current, { t_sign_end: sign.t_sign_end, t_predicted: sign.t_predicted, at: sign.at, shownAt: Date.now() / 1000 });
        setStages(latencyStages(data.current));
        setSeen((s) => ({ signs: s.signs + 1, timed: s.timed + (typeof sign.t_sign_end === "number" ? 1 : 0) }));
      }),
    );
  }, []);

  return { stages, seen, record };
}

function Destinations({ list, empty }: { list: EgressEntry[]; empty: string }) {
  if (list.length === 0) return <p className={styles.value}>{empty}</p>;
  return (
    <ul className={styles.list}>
      {list.map((e) => (
        <li key={e.destination}>
          <span className={styles.host}>{e.destination}</span>: {e.calls} {e.calls === 1 ? "request" : "requests"}, last at {clock(e.lastAt)}
          <span className={styles.note}>{KNOWN[e.destination] ?? "not a destination this app is known to use"}</span>
        </li>
      ))}
    </ul>
  );
}

export function TrustPanels({ latency }: { latency: ReturnType<typeof useSignLatency> }) {
  const [trust, setTrust] = useState<Trust | null>(null);
  const [error, setError] = useState("");
  const [wiping, setWiping] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/trust", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTrust((await res.json()) as Trust);
      setError("");
    } catch (err) {
      setError(`Could not read the counters (${err instanceof Error ? err.message : "error"}). No numbers are shown until they can be read.`);
      setTrust(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  async function wipeSession() {
    if (!window.confirm("Wipe this guest's session? The guest's sentences are cleared from the server and from both screens.")) return;
    setWiping(true);
    try {
      const res = await fetch("/api/trust", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "wipe" }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTrust((await res.json()) as Trust);
      setError("");
    } catch (err) {
      setError(`The wipe failed (${err instanceof Error ? err.message : "error"}). Nothing was reported as wiped.`);
    } finally {
      setWiping(false);
    }
  }

  const e = trust?.egress;
  const counting = Boolean(e?.installed);

  return (
    <div className={styles.panels}>
      <section className={styles.card} aria-label="Privacy">
        <h2 className={styles.title}>Privacy, measured on this laptop</h2>
        {error && <p className={styles.error}>{error}</p>}
        {trust && e && (
          <>
            <div className={styles.row}>
              <span className={styles.label}>Requests this server sent off the laptop, this session</span>
              {counting ? (
                <>
                  <p className={styles.big}>{total(e.session)}</p>
                  <Destinations list={e.session} empty="None since this session started." />
                  <p className={styles.note}>
                    Session started {clock(e.sessionStartedAt)}. Since the server started ({clock(e.startedAt)}): {total(e.sinceStart)}
                    {e.sinceStart.length > 0 && ` (${e.sinceStart.map((d) => `${d.destination} ${d.calls}`).join(", ")})`}.
                  </p>
                </>
              ) : (
                <p className={styles.value}>Counter not running (web/instrumentation.ts did not load), so no number is shown.</p>
              )}
            </div>

            <div className={styles.row}>
              <span className={styles.label}>Face points passed to the classifier</span>
              <p className={styles.big}>0</p>
              <p className={styles.note}>
                By design, not measured by the app: the classifier&apos;s input has no face features (recognition/features.py), and the live
                landmark adapter drops the face points by default (recognition/mediapipe_adapter.py). The recognizer sends this app sign labels and scores only, never video or landmarks.
              </p>
            </div>

            <div className={styles.row}>
              <span className={styles.label}>Session data wiped</span>
              {e.lastWipe ? (
                <p className={styles.value}>
                  <strong>Yes</strong>, at {clock(e.lastWipe.at)}: {e.lastWipe.itemsErased} guest {e.lastWipe.itemsErased === 1 ? "item" : "items"} erased
                  from the server; both screens were told to clear. Held since then: {trust.heldItems}.
                </p>
              ) : (
                <p className={styles.value}>
                  <strong>No</strong>. The server holds {trust.heldItems} guest {trust.heldItems === 1 ? "item" : "items"} in memory (signs in progress, last
                  sentence, framing hint).
                </p>
              )}
              <button type="button" className={styles.button} onClick={() => void wipeSession()} disabled={wiping}>
                {wiping ? "Wiping…" : "Wipe this guest's session"}
              </button>
            </div>

            <p className={styles.footnote}>
              What this does not see: requests made by the browsers themselves (the browser speech recognition used for push-to-talk fallback and
              hands-free listening can send audio to the browser maker), and the recognizer, which runs as its own process. Requests to this laptop
              (localhost) are not counted.
            </p>
          </>
        )}
      </section>

      <section className={styles.card} aria-label="Latency">
        <h2 className={styles.title}>Latency, from event timestamps</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Stage</th>
              <th>Last</th>
              <th>Median</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {latency.stages.map((s) => (
              <tr key={s.key}>
                <td>{s.label}</td>
                <td>{ms(s.lastMs)}</td>
                <td>{ms(s.medianMs)}</td>
                <td>{s.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.note}>
          Signs seen on this page: {latency.seen.signs}, with recognizer timestamps: {latency.seen.timed}.{" "}
          {latency.seen.signs > 0 && latency.seen.timed === 0 &&
            "The recognizer sends no t_sign_end (recognition.live_key does not; recognition.live does), so only the app-to-screen stage has data. "}
          Values below 0 or above 60 s are dropped.
        </p>
      </section>
    </div>
  );
}
