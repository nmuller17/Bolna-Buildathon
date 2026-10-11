// SignBridge app (P4, builder A): recognizer bridge ingest (docs/app-plan.md 6.1 to 6.3).
//
// Called by POST /api/guest/signs (real recognizer, after the key check) and by POST
// /api/dev/simulate (source "simulated"). Order of work for one event:
//   1. validate (unknown keys ignored, known keys strict, face/frames/pose/video refused and counted);
//   2. freshness: t_sent more than 5 s old or ahead, or (signs) older than the session -> "stale"
//      (shared contract 2026-10-11: no recognizer sends t_sent yet, so a missing t_sent means "now");
//   3. framing, status and capture are always accepted (no personal data) and stored (C1-10);
//   4. sign and utterance pass the consent gate (ACTIVE and the guest chose Sign), else 409;
//   5. sign: restart-tolerant replay check (C1-11), store, live_sign to both screens;
//   6. utterance (live.py stream shape or live_key.py sentence shape): join with stored sign events
//      (by seqs, else with the run's sign events since the last utterance; top-1 fallback), the app's
//      own gate, the recognizer's sentence correction as "Did you mean" (match.ts
//      applySentenceCorrection), proposal protection with the 10 s grace (C1-5), the 4 s
//      hold-and-merge (C1-17), repeat or proposal.
import { recordLatency } from "./latency.ts";
import { applySentenceCorrection, decide, lightFor, barFor, mergeHeld, type JoinedSign } from "./match.ts";
import { guestView, type Store } from "./store.ts";
import { validateBridgeEvent, type ValidSign, type ValidUtterance } from "./validate.ts";
import { FRAMING_GUIDANCE, FRAMING_STAFF_HINT, LIMITS, type Prediction, type RepeatReason, type SignLabel, type SignsSource, type StaffSignView } from "./types.ts";

export type IngestResult = { status: number; body: Record<string, unknown> };

const okOut = (outcome: string, proposalId: string | null = null): IngestResult => ({ status: 200, body: { ok: true, outcome, proposalId } });
const failOut = (status: number, error: string, message: string): IngestResult => ({ status, body: { ok: false, error, message } });

export function ingestBridge(store: Store, raw: unknown, source: SignsSource): IngestResult {
  // Reserved slot (plan 6.8): ignored with 404 unless VLM_FALLBACK=1 (GST-7a).
  if (typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "vlm_suggestion" && !store.config.vlmFallback) {
    return failOut(404, "not_found", "The local vision-model fallback is switched off.");
  }
  const v = validateBridgeEvent(raw);
  if (!v.ok) {
    if (v.refusedKeys.length) {
      store.bothPrivacy((p) => {
        for (const k of v.refusedKeys) p.refusedBodyKeys[k]++;
      });
    }
    return failOut(400, "bad_request", v.message);
  }
  const ev = v.event;
  const now = store.now();
  const nowS = now / 1000;
  // Shared contract: t_sent is optional; without it the event is taken as sent when it arrived.
  const tSent = ev.t_sent ?? nowS;
  if (tSent < nowS - LIMITS.bridgeMaxAgeMs / 1000 || tSent > nowS + LIMITS.bridgeMaxAgeMs / 1000) return okOut("stale");

  const r = store.recognizer;
  const markSeen = () => {
    r.lastEventAt = now;
    r.source = source;
  };

  if (ev.type === "status") {
    markSeen();
    r.mode = ev.recognizer;
    r.fps = ev.fps ?? null;
    store.bothPrivacy((p) => p.bridgeEvents++);
    store.updateSigningAvailable();
    return okOut("status");
  }

  if (ev.type === "framing") {
    markSeen();
    store.bothPrivacy((p) => p.bridgeEvents++);
    const changed = r.framing !== ev.status;
    r.framing = ev.status;
    if (ev.status === "OK") r.framingNotOkSince = null;
    else if (r.framingNotOkSince === null) r.framingNotOkSince = ev.since === undefined ? now : Math.min(now, Math.round(ev.since * 1000));
    const s = store.session;
    if (ev.rejected_seq !== undefined && s) markRejected(store, source, ev.rejected_seq, ev.run);
    store.toStaff({
      type: "framing",
      status: ev.status,
      hint: FRAMING_STAFF_HINT[ev.status] ?? (ev.status === "OK" ? "" : FRAMING_GUIDANCE[ev.status]),
      rejectedSeq: ev.rejected_seq ?? null,
      notOkSince: r.framingNotOkSince,
    });
    // Guest sees framing text only while signing (plan 6.4).
    if (s && s.state === "ACTIVE" && s.guestMode === "sign" && (changed || ev.rejected_seq !== undefined)) {
      store.toGuest({ type: "framing", status: ev.status, text: FRAMING_GUIDANCE[ev.status] });
    }
    return okOut("framing");
  }

  if (ev.type === "capture") {
    // live_key.py recording phase: no personal data, accepted outside the consent gate and stored for
    // the screens (a countdown on the guest screen is a later screen task).
    markSeen();
    store.bothPrivacy((p) => p.bridgeEvents++);
    r.capture = { phase: ev.phase, at: now, countdown: ev.countdown ?? null, duration: ev.duration ?? null };
    return okOut("capture");
  }

  if (ev.type === "vlm_suggestion") {
    // Stub only: recorded on the staff log, never shown to the guest in this build (GST-7a, plan 6.8).
    markSeen();
    store.systemLine(`A local vision-model suggestion arrived (${ev.label}); the fallback UI is not built yet, so it was not shown`);
    return okOut("stored");
  }

  // sign and utterance: consent gate (BRG-4).
  const s = store.session;
  if (!s || s.state !== "ACTIVE" || s.guestMode !== "sign") {
    return failOut(409, "conflict", "The guest has not chosen to sign; signs are not accepted.");
  }
  if (tSent * 1000 < (s.activeSince ?? now)) return okOut("stale");
  markSeen();

  if (ev.type === "sign") return ingestSign(store, ev, source);
  return ingestUtterance(store, ev, source);
}

function track(store: Store, source: SignsSource, run: string | undefined) {
  let t = store.runs[source];
  if (!t || (run !== undefined && t.run !== run) || (run === undefined && !t.run.startsWith("local-") && t.fromRecognizer)) {
    const restarted = t !== null;
    t = { run: run ?? `local-${++store.localRuns}`, fromRecognizer: run !== undefined, lastSeq: 0, seen: new Set(), rejected: new Set(), sentence: [] };
    store.runs[source] = t;
    if (restarted) noteRestart(store, t.run);
  }
  if (source === "recognizer") store.recognizer.run = t.run;
  return t;
}

function noteRestart(store: Store, run: string) {
  store.recognizer.restarts++;
  store.recognizer.run = run;
  store.systemLine("The recognizer restarted");
}

function signKey(source: SignsSource, run: string, seq: number) {
  return `${source}|${run}|${seq}`;
}

function markRejected(store: Store, source: SignsSource, seq: number, run: string | undefined) {
  const t = track(store, source, run);
  t.rejected.add(seq);
  const s = store.session;
  const stored = s?.signEvents.get(signKey(source, t.run, seq));
  if (stored) {
    stored.framingRejected = true;
    stored.light = "red";
    stored.red = "framing";
  }
}

function ingestSign(store: Store, ev: ValidSign, source: SignsSource): IngestResult {
  const s = store.session!;
  const now = store.now();
  let t = track(store, source, ev.run);
  // Replay and restarts (BRG-3): with a run id, (run, seq) seen before is a duplicate. Without one,
  // the same seq as the last is a duplicate and a LOWER seq is a restart, never dropped (C1-11).
  if (ev.run !== undefined) {
    if (t.seen.has(ev.seq)) return dup(store);
  } else if (ev.seq === t.lastSeq) {
    return dup(store);
  } else if (ev.seq < t.lastSeq) {
    t = { run: `local-${++store.localRuns}`, fromRecognizer: false, lastSeq: 0, seen: new Set(), rejected: new Set(), sentence: [] };
    store.runs[source] = t;
    if (source === "recognizer") noteRestart(store, t.run);
    else store.systemLine("The simulator restarted its sign numbers");
  }
  t.lastSeq = Math.max(t.lastSeq, ev.seq);
  t.seen.add(ev.seq);
  if (t.seen.size > 512) t.seen.delete(t.seen.values().next().value as number);
  t.sentence.push(ev.seq);
  if (t.sentence.length > 32) t.sentence.shift();

  const joined: JoinedSign = { seq: ev.seq, top: ev.top, joined: true, framingRejected: t.rejected.has(ev.seq) };
  const l = lightFor(joined);
  const view: StaffSignView & { framingRejected: boolean } = {
    seq: ev.seq, top: ev.top, joined: true, light: l.light, red: l.red, bar: barFor(ev.top[0].label),
    tSignStart: ev.t_sign_start ?? null, tSignEnd: ev.t_sign_end ?? null, tPredicted: ev.t_predicted ?? null, receivedAt: now,
    skeleton: ev.skeleton ?? null, framingRejected: joined.framingRejected,
  };
  s.signEvents.set(signKey(source, t.run, ev.seq), view);
  if (s.signEvents.size > 128) s.signEvents.delete(s.signEvents.keys().next().value as string);
  const { framingRejected: _fr, ...evidence } = view;
  void _fr;
  s.evidence.push(evidence);
  if (s.evidence.length > 100) s.evidence.shift();

  // Latency from the recognizer's own timestamps (laptop clock, plan 6.5), only when it sent them
  // (live.py does; live_key.py does not, and then no number is invented).
  if (ev.t_predicted !== undefined && ev.t_sign_end !== undefined) {
    recordLatency(store.latency, "movement_to_prediction", (ev.t_predicted - ev.t_sign_end) * 1000);
  }
  if (ev.t_predicted !== undefined) recordLatency(store.latency, "prediction_to_app", now - ev.t_predicted * 1000);
  store.bothPrivacy((p) => p.bridgeEvents++);
  const skeletons = [...s.signEvents.values()].filter((x) => x.skeleton !== null).length;
  store.thisGuest.skeletonsHeld = skeletons;
  store.sinceStart.skeletonsHeld = skeletons;
  store.touch(s); // an accepted sign from the desk camera is activity (AS-16)

  store.toGuest({ type: "live_sign", sign: guestView(view), simulated: source === "simulated" });
  store.toStaff({ type: "live_sign", sign: evidence, source });
  return okOut("stored");
}

function dup(store: Store): IngestResult {
  store.raiseWarning("recognizer_event", "The recognizer sent the same sign twice.");
  return okOut("duplicate");
}

function ingestUtterance(store: Store, ev: ValidUtterance, source: SignsSource): IngestResult {
  const s = store.session!;
  const now = store.now();
  const t = track(store, source, ev.run);
  const lookup = (seq: number) => s.signEvents.get(signKey(source, t.run, seq));
  // seqs from the utterance (live.py), else matched against this run's sign events since the last utterance.
  const seqs: (number | null)[] = ev.seqs ?? joinSentence(ev.labels, t.sentence, lookup, ev.shape);
  t.sentence = [];
  const key = `${t.run}|${seqs.join(",")}|${ev.labels.join(",")}|${ev.corrected?.join(",") ?? ""}|${ev.t_end ?? (ev.seqs ? "" : now)}`;
  if (s.seenUtterances.has(key)) return dup(store);
  s.seenUtterances.add(key);
  if (s.seenUtterances.size > 256) s.seenUtterances.delete(s.seenUtterances.values().next().value as string);

  store.bothPrivacy((p) => p.bridgeEvents++);
  store.touch(s);

  // Join each sign with its stored sign event; a missing one uses the utterance's top-1 only (BRG-8).
  // The sentence shape (live_key.py) carries no score, so an unjoined sign there has none (0, red):
  // the app never invents confidence.
  let joined: JoinedSign[] = ev.labels.map((label, i) => {
    const seq = seqs[i];
    const stored = seq !== null ? lookup(seq) : undefined;
    if (stored && seq !== null) return { seq, top: stored.top, joined: true, framingRejected: stored.framingRejected };
    const own: Prediction = { label, conf: ev.confs?.[i] ?? 0 };
    return { seq, top: [own], joined: false, framingRejected: seq !== null && t.rejected.has(seq) };
  });
  const viewsFor = (signs: JoinedSign[]): StaffSignView[] =>
    signs.map((j) => {
      const stored = j.seq !== null ? s.signEvents.get(signKey(source, t.run, j.seq)) : undefined;
      const l = lightFor(j);
      return {
        seq: j.seq, top: j.top, joined: j.joined, light: l.light, red: l.red, bar: barFor(j.top[0].label),
        tSignStart: stored?.tSignStart ?? null, tSignEnd: stored?.tSignEnd ?? null, tPredicted: stored?.tPredicted ?? null,
        receivedAt: stored?.receivedAt ?? now, skeleton: stored?.skeleton ?? null,
      };
    });
  const recognition = (outcome: "proposal" | "did_you_mean" | "did_you_mean_help" | "pick" | "unmatched" | "repeat" | "ignored_pending" | "held", extra: { repeatReason?: RepeatReason | null; proposalId?: string | null; views: StaffSignView[] }) => {
    store.toStaff({
      type: "recognition", source, receivedAt: now, signs: extra.views, outcome, repeatReason: extra.repeatReason ?? null,
      recognizerSaidRepeat: ev.needs_repeat, candidates: s.pending && extra.proposalId === s.pending.proposal.proposalId ? s.pending.proposal.candidates : [],
      proposalId: extra.proposalId ?? null, testMode: store.recognizer.mode === "mock",
    });
  };
  const ignore = (views: StaffSignView[]) => {
    s.counters.ignoredWhilePending++;
    store.systemLine("Camera saw a movement while the guest was choosing; ignored");
    recognition("ignored_pending", { views });
    return okOut("ignored_pending");
  };

  // A pending NAME proposal ignores every utterance: the guest is typing (C1-5).
  if (s.pending && s.pending.proposal.candidates.some((c) => c.needsName) && s.pending.proposal.candidates.length === 1) {
    return ignore(viewsFor(joined));
  }

  // Hold-and-merge (SPK-9): an unmatched utterance waits 4 s for the next one.
  if (s.held && now <= s.held.expiresAt) {
    const merged = mergeHeld(s.held.signs, joined);
    if (merged) joined = merged;
    else store.systemLine("Earlier signs were dropped: too many signs in a row");
    s.held = null;
  }

  // The recognizer's own sentence correction (live_key.py `snapped`) is applied only to this utterance's
  // signs, never across a hold-and-merge (positions would not line up).
  const outcome = applySentenceCorrection(decide(joined), joined, joined.length === ev.labels.length ? ev.corrected : null);
  const views = viewsFor(joined);

  if (s.pending && (outcome.kind === "repeat" || outcome.kind === "hold")) return ignore(views);

  if (outcome.kind === "hold") {
    s.held = { signs: joined, at: now, expiresAt: now + LIMITS.unmatchedMergeMs, tEnd: ev.t_end ?? nowS(store), source, saidRepeat: ev.needs_repeat };
    recognition("held", { views });
    return okOut("held");
  }

  if (outcome.kind === "repeat") {
    s.repeatStreak++;
    s.counters.repeats++;
    const framingText = outcome.reason === "framing" && store.recognizer.framing ? FRAMING_GUIDANCE[store.recognizer.framing] : null;
    store.toGuest({ type: "repeat_request", reason: outcome.reason, signs: views.map(guestView), weak: outcome.weak, framingText, streak: s.repeatStreak });
    store.toStaff({ type: "repeat_request", reason: outcome.reason, count: s.counters.repeats, streak: s.repeatStreak });
    store.pushLog(s, { kind: "repeat", seq: store.nextLogSeq(s), at: now, reason: outcome.reason, recognizerSaidRepeat: ev.needs_repeat });
    recognition("repeat", { views, repeatReason: outcome.reason });
    return okOut("repeat");
  }

  const proposalId = store.propose(outcome.kind, outcome.candidates, views, ev.t_end ?? nowS(store), source);
  recognition(outcome.kind, { views, proposalId });
  return okOut("proposal", proposalId);
}

const nowS = (store: Store) => store.now() / 1000;

/**
 * Seqs for an utterance that carries none (live_key.py, live_window.py): match its labels, from the
 * end, against this run's sign events since the last utterance, skipping events that do not match
 * (a sign undone with BACKSPACE sends no event of its own). The sentence shape compares the best
 * non-NONE label of each sign event (live_key's `raw` leaves NONE out); the stream shape its top-1.
 * A label with no matching event gets null and is evaluated unjoined.
 */
export function joinSentence(
  labels: readonly SignLabel[],
  sentence: readonly number[],
  lookup: (seq: number) => { top: readonly Prediction[] } | undefined,
  shape: "stream" | "sentence",
): (number | null)[] {
  const out: (number | null)[] = labels.map(() => null);
  const labelOf = (top: readonly Prediction[]) => (shape === "sentence" ? top.find((p) => p.label !== "NONE")?.label : top[0]?.label);
  let j = sentence.length - 1;
  for (let i = labels.length - 1; i >= 0; i--) {
    for (let k = j; k >= 0; k--) {
      const v = lookup(sentence[k]);
      if (v && labelOf(v.top) === labels[i]) {
        out[i] = sentence[k];
        j = k - 1;
        break;
      }
    }
  }
  return out;
}

/** GET /api/guest/signs: whether signs are accepted right now (BRG-4). */
export function accepting(store: Store): boolean {
  const s = store.session;
  return !!s && s.state === "ACTIVE" && s.guestMode === "sign";
}
