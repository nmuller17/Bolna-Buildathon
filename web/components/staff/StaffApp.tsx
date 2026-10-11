"use client";
// P4 (builder B): the staff dashboard (docs/app-plan.md 4.2): header strip, recognizer fallback band,
// alerts, talk column, conversation log with live signs, check-in co-pilot and the bottom tabs.
import { useEffect, useRef, useState } from "react";
import { KeyTag, SimulatedBadge, TrafficLight } from "@/components/app/KeyTag";
import { tagText } from "@/components/app/displayVocab";
import {
  FRAMING_GUIDANCE,
  FRAMING_STAFF_HINT,
  GUEST_REPLY_TEXT,
  LIMITS,
  VRI_UNSET_TEXT,
  type LogEntry,
  type StaffStatus,
} from "@/lib/app/types";
import { BottomTabs, Checklist, clock, type TabKey } from "./Panels";
import TalkPanel from "./TalkPanel";
import { useStaffDesk, type Desk } from "./useStaffDesk";
import s from "./staff.module.css";

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const mmss = (msLeft: number) => {
  const t = Math.max(0, Math.round(msLeft / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** "10 min", "2 min", "90 s": the idle value in force, shown in the header (C1-8). */
const duration = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`);

export default function StaffApp() {
  const desk = useStaffDesk();
  const { ui } = desk;
  const [tab, setTab] = useState<TabKey>("evidence");
  const [drawerOpen, setDrawerOpen] = useState(true);

  if (!ui.started) {
    return (
      <main className={s.startScreen}>
        <div className={s.startCard}>
          <p className={s.brandLine}>
            SignBridge <span>front-desk communication aid</span>
          </p>
          <h1 className={s.startTitle}>Start the desk</h1>
          <p>Starting unlocks this laptop&apos;s speaker for guest sentences, signs this screen in, and warms up the voice.</p>
          <p className={s.hint}>Use Chrome on this laptop. Start the recognizer only after the header says &ldquo;Voice: ready&rdquo;.</p>
          <button type="button" className={s.startButton} onClick={() => void desk.start()}>
            Start desk
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className={s.root}>
      <Header desk={desk} />
      <FallbackBand status={ui.status} />
      <Alerts desk={desk} />
      <WarningStrip
        desk={desk}
        onOpen={() => {
          setTab("safety");
          setDrawerOpen(true);
        }}
      />
      {ui.lastError && (
        <p className={s.errorLine} role="alert">
          {ui.lastError}{" "}
          <button type="button" className={s.linkBtn} onClick={() => desk.setError(null)}>
            Dismiss
          </button>
        </p>
      )}
      {ui.sessionState === "NO_SESSION" ? (
        <NoGuest desk={desk} />
      ) : (
        <div className={s.columns}>
          <TalkPanel desk={desk} />
          <Middle desk={desk} />
          <Checklist desk={desk} />
        </div>
      )}
      <BottomTabs desk={desk} tab={tab} setTab={setTab} open={drawerOpen} setOpen={setDrawerOpen} />
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Header strip (DSH-1)                                                */
/* ------------------------------------------------------------------ */

function Header({ desk }: { desk: Desk }) {
  const { ui, staffAction } = desk;
  const st = ui.status;
  const now = useNow();
  const modeBadge = st
    ? `${st.mode === "mode0" ? "Mode 0" : st.mode === "modeC" ? "Mode C" : "Mode W"}, ${st.profile}${st.mode === "mode0" ? (st.mode0GuestInput ? ", guest input on" : ", display only") : ""}`
    : "connecting";
  const heardAgo = st?.guest.lastHeardAt ? now - st.guest.lastHeardAt : null;
  const heardLevel = heardAgo === null ? "none" : heardAgo > LIMITS.heartbeatRedMs ? "red" : heardAgo > LIMITS.heartbeatAmberMs ? "amber" : "ok";
  const idleLeft = st?.session.idleWipeAt ? st.session.idleWipeAt - now : null;
  const capLeft = st?.session.capAt ? st.session.capAt - now : null;
  const rec = st?.recognizer;
  const framingBadFor = rec?.framingNotOkSince ? now - rec.framingNotOkSince : null;
  const hasSession = ui.sessionState !== "NO_SESSION";
  const device = st?.guest.device ?? null;
  const guestWhere = device ? (st?.mode === "mode0" ? "this laptop (Mode 0)" : `${device.deviceClass}, ${device.address}`) : hasSession ? "not connected yet" : "none";
  const keyTrigger = rec?.trigger === "key";
  const recWords = rec
    ? keyTrigger && rec.controlUp === false
      ? "live_key not answering"
      : rec.state === "down"
        ? "down"
        : `${rec.mode ?? rec.state}${keyTrigger ? ", live_key (tap to record)" : ""}`
    : "unknown";
  const simulated = rec?.source === "simulated";

  return (
    <header className={s.header}>
      <div className={s.headerTop}>
        <p className={s.brandLine}>
          SignBridge <span>front-desk communication aid</span>
        </p>
        <span className={s.modeBadge}>{modeBadge}</span>
        <span className={s.connBadge} data-state={ui.conn}>
          {ui.conn === "open" ? "Connected to the desk server" : ui.conn === "unauthorized" ? "Not signed in" : "Reconnecting…"}
        </span>
        <div className={s.headerActions}>
          {hasSession ? (
            <button type="button" className={s.endButton} onClick={() => void staffAction({ type: "end_guest" })}>
              End guest
            </button>
          ) : null}
        </div>
      </div>
      <dl className={s.slats}>
        <div>
          <dt>Guest window</dt>
          <dd>{guestWhere}</dd>
        </div>
        <div data-level={hasSession ? heardLevel : "none"}>
          <dt>Guest screen</dt>
          <dd>
            {heardAgo === null ? "not heard yet" : `heard ${Math.round(heardAgo / 1000)} s ago`}
            {heardLevel === "red" && ", check on the guest"}
            {st && st.guest.streams > 1 && ` (${st.guest.streams} streams)`}
          </dd>
        </div>
        <div>
          <dt>Idle wipe</dt>
          <dd>
            {idleLeft !== null ? mmss(idleLeft) : "—"} <span className={s.slatNote}>({st?.profile ?? "?"}: {st ? duration(st.session.idleWipeMs) : "?"})</span>
          </dd>
        </div>
        <div data-level={capLeft !== null && capLeft <= LIMITS.capWarnBeforeMs ? "amber" : "ok"}>
          <dt>Session ends in</dt>
          <dd>
            {capLeft !== null ? mmss(capLeft) : "—"}
            {capLeft !== null && capLeft <= LIMITS.capWarnBeforeMs && (
              <button type="button" className={s.inlineBtn} onClick={() => void staffAction({ type: "extend" })}>
                Extend 5 min
              </button>
            )}
          </dd>
        </div>
        <div data-level={!rec || rec.state === "down" || rec.mode !== "ok" ? "amber" : "ok"}>
          <dt>Recognizer</dt>
          <dd>
            {simulated ? "simulator" : recWords}
            {rec?.fps && !simulated ? `, ${Math.round(rec.fps)} fps` : ""}
          </dd>
        </div>
        <div data-level={rec?.framing && rec.framing !== "OK" ? "amber" : "ok"}>
          <dt>Framing</dt>
          <dd>
            {rec?.framing ? rec.framing.replace(/_/g, " ").toLowerCase() : keyTrigger ? "not reported" : "—"}
            {framingBadFor !== null && framingBadFor > LIMITS.framingStuckHintMs && `, not OK for ${Math.round(framingBadFor / 1000)} s`}
          </dd>
        </div>
        <div data-level={ui.voice === "ready" || ui.voice === "local" ? "ok" : "amber"}>
          <dt>Voice</dt>
          <dd>{ui.voice === "warming" ? "warming up" : ui.voice === "ready" ? "ready" : ui.voice === "failed" ? "local voice only" : ui.voice === "local" ? "on-device only" : "off"}</dd>
        </div>
        <div>
          <dt>Vendor keys</dt>
          <dd>{st ? (st.privacy.sinceStart.vendorKeysConfigured.length ? st.privacy.sinceStart.vendorKeysConfigured.join(", ") : "none") : "—"}</dd>
        </div>
      </dl>
      {rec?.framing && rec.framing !== "OK" && framingBadFor !== null && framingBadFor > LIMITS.framingStuckHintMs && (
        <p className={s.framingHint}>{FRAMING_STAFF_HINT[rec.framing] ?? FRAMING_GUIDANCE[rec.framing]}</p>
      )}
      {ui.claimError && <p className={s.framingHint}>{ui.claimError}</p>}
      {ui.conn === "unauthorized" && (
        <p className={s.framingHint}>This screen is not signed in. Open the one-time link the server printed (kill -USR2 &lt;server pid&gt; prints a new one).</p>
      )}
    </header>
  );
}

/** Large band when signing cannot work (DSH-11, C1-9), or a declared band while the simulator drives it. */
function FallbackBand({ status }: { status: StaffStatus | null }) {
  const now = useNow();
  if (!status) return null;
  const r = status.recognizer;
  if (r.source === "simulated" && r.mode === "ok") {
    return (
      <div className={s.simBand} role="status">
        <strong>Simulator rehearsal.</strong> Signs come from the Simulator tab, not the desk camera, and carry a SIMULATED badge on both screens. Say so out loud on stage.
      </div>
    );
  }
  const silent = r.lastEventAt === null || now - r.lastEventAt > 5_000;
  let why: string | null = null;
  if (r.trigger === "key" && r.controlUp === false) why = "live_key.py does not answer on its control port (start it with --no-preview --control-port and --post)";
  else if (r.mode === "no_model") why = "the recognizer reports no model";
  else if (r.mode === "mock") why = "the recognizer is in mock mode (invented signs, never spoken)";
  else if (r.state === "down" || (r.signingAvailable === false && silent) || (r.signingAvailable === undefined && silent))
    why = r.lastEventAt === null ? "no recognizer has connected yet" : "the recognizer has sent nothing for over 5 seconds";
  if (!why) return null;
  return (
    <div className={s.fallbackBand} role="status">
      <strong>Signing is not available: {why}.</strong> Use Phrases or Type, or switch to the declared simulator rehearsal.
    </div>
  );
}

/** Open session warnings stay visible above the columns (plan 6.6); the Safety tab has the details. */
function WarningStrip({ desk, onOpen }: { desk: Desk; onOpen: () => void }) {
  const open = desk.ui.warnings.filter((w) => w.open);
  if (open.length === 0) return null;
  const latest = open[open.length - 1];
  return (
    <div className={s.warnStrip} role="status">
      <span>
        <strong>{open.length === 1 ? "Session warning:" : `${open.length} session warnings. Latest:`}</strong> {latest.text}
      </span>
      <button type="button" className={s.bannerBtnDark} onClick={onOpen}>
        Open Safety
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Alerts (plan 4.2 "Alerts")                                          */
/* ------------------------------------------------------------------ */

function Alerts({ desk }: { desk: Desk }) {
  const { ui, ack, staffAction, readAloudTyped, dismissTyped, dismissReply } = desk;
  const now = useNow();
  return (
    <>
      {ui.emergency && (
        <div className={s.helpBanner} role="alert">
          <span className={s.helpText}>
            Guest wants staff at the desk now
            {ui.emergency.count > 1 && <span className={s.helpCount}>Help pressed {ui.emergency.count} times: go now</span>}
          </span>
          <button type="button" className={s.helpAck} onClick={() => void ack("emergency")}>
            I&apos;m coming
          </button>
        </div>
      )}
      {ui.interpreter && (
        <div className={s.navyBanner} role="alert">
          <span>
            <strong>The guest asked for a human interpreter.</strong>{" "}
            {ui.interpreter.vri.label || ui.interpreter.vri.contact
              ? `${ui.interpreter.vri.label ?? ""} ${ui.interpreter.vri.contact ? `${ui.interpreter.vri.contact.kind === "videophone" ? "Videophone" : "Text"}: ${ui.interpreter.vri.contact.value}` : ""}`
              : `No interpreter service is configured: arrange one by phone and tell the guest how long it will take. (${VRI_UNSET_TEXT})`}
          </span>
          <button type="button" className={s.bannerBtn} onClick={() => void ack("interpreter")}>
            I&apos;m on it
          </button>
        </div>
      )}
      {ui.moreTime && (
        <div className={s.brassBanner} role="status">
          <span>Guest needs more time.</span>
          <button type="button" className={s.bannerBtnDark} onClick={() => void ack("more_time")}>
            Keep open
          </button>
        </div>
      )}
      {ui.idleWarnUntil && ui.idleWarnUntil > now && (
        <div className={s.brassBanner} role="status">
          <span>
            <strong>This session will end soon.</strong> No staff action for a while: the conversation is wiped in {mmss(ui.idleWarnUntil - now)}.
          </span>
          <button type="button" className={s.bannerBtnDark} onClick={() => void staffAction({ type: "touch" })}>
            Guest is still here: keep open
          </button>
        </div>
      )}
      {ui.capWarnUntil && ui.capWarnUntil > now && (
        <div className={s.brassBanner} role="status">
          <span>
            <strong>This session will end soon.</strong> It reaches its time limit in {mmss(ui.capWarnUntil - now)}.
          </span>
          <button type="button" className={s.bannerBtnDark} onClick={() => void staffAction({ type: "extend" })}>
            Extend 5 min
          </button>
        </div>
      )}
      {ui.typed.map((t) => (
        <div key={t.logSeq} className={s.brassBanner} role="status">
          <span>
            <strong>The guest typed:</strong> &ldquo;{t.text}&rdquo;
          </span>
          <span className={s.row}>
            <button type="button" className={s.bannerBtnDark} onClick={() => void readAloudTyped(t.logSeq)}>
              Read aloud
            </button>
            <button type="button" className={s.linkBtn} onClick={() => dismissTyped(t.logSeq)}>
              Dismiss
            </button>
          </span>
        </div>
      ))}
      {ui.replies.map((r) => (
        <div key={r.key} className={s.brassBanner} role="status">
          <span>
            <strong>Guest:</strong> &ldquo;{GUEST_REPLY_TEXT[r.reply]}&rdquo; ({clock(r.at, true)})
          </span>
          <button type="button" className={s.linkBtn} onClick={() => dismissReply(r.key)}>
            Dismiss
          </button>
        </div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* No guest / session start (Mode 0)                                   */
/* ------------------------------------------------------------------ */

function NoGuest({ desk }: { desk: Desk }) {
  const { ui, staffAction } = desk;
  const r = ui.receipt ?? ui.status?.privacy.lastWipe ?? null;
  const reasonWords: Record<string, string> = {
    staff_ended: "End guest",
    idle: "idle wipe",
    cap: "time limit",
    guest_left: "the guest ended the conversation",
    pair_failed: "pairing failed",
    repaired: "reconnected",
    server_restart: "server restart",
  };
  return (
    <section className={s.noGuest}>
      <h2 className={s.noGuestTitle}>No guest.</h2>
      {r && (
        <p>
          Last wipe {clock(r.at, true)}, reason: {reasonWords[r.reason] ?? r.reason}, {r.itemsErased} items erased.
        </p>
      )}
      <button type="button" className={s.newButtonLarge} onClick={() => void staffAction({ type: "new_guest" })}>
        New guest
      </button>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Middle column: session controls, log, live signs, latest sentence   */
/* ------------------------------------------------------------------ */

function SessionControls({ desk }: { desk: Desk }) {
  const { ui, staffAction } = desk;
  const [popupNote, setPopupNote] = useState<string | null>(null);
  const [check, setCheck] = useState("");
  const st = ui.status;
  const displayOnly = st?.mode === "mode0" && !st.mode0GuestInput;

  if (ui.sessionState === "WAITING_FOR_GUEST" || ui.sessionState === "AWAITING_PAIR") {
    const openWindow = async () => {
      const res = await staffAction({ type: "open_guest_window" });
      const url = res && res.ok ? res.guestUrl : undefined;
      if (!url) return;
      // The guest window runs on localhost, a different cookie site from this staff window (C1-3).
      window.open(url, "signbridge-guest", "noopener");
      setPopupNote("Drag the new window to the guest display. If no window opened, allow pop-ups for this page and press the button again.");
    };
    return (
      <div className={s.sessionBox}>
        {st?.mode === "mode0" ? (
          <>
            <p>Open the guest window and drag it to the wired display that faces the guest.</p>
            <button type="button" className={s.primary} onClick={() => void openWindow()}>
              Open guest window
            </button>
            {popupNote && <p className={s.hint}>{popupNote}</p>}
          </>
        ) : (
          <p>Pairing a separate guest device is not part of this build (Tier 1).</p>
        )}
      </div>
    );
  }
  if (ui.sessionState === "PAIRED_UNCONFIRMED") {
    return (
      <div className={s.sessionBox}>
        <p>
          A device joined{st?.guest.device ? `: ${st.guest.device.deviceClass}, ${st.guest.device.address}` : ""}. Check it is the device in the guest&apos;s hand, then type the number shown on it.
        </p>
        <div className={s.row}>
          <input className={s.input} inputMode="numeric" maxLength={7} value={check} aria-label="Number shown on the guest device" onChange={(e) => setCheck(e.target.value.replace(/\D/g, ""))} />
          <button type="button" className={s.primary} disabled={check.length !== 6} onClick={() => void staffAction({ type: "confirm_pair", check })}>
            Confirm
          </button>
        </div>
        <p className={s.hint}>{st?.guest.confirmTriesLeft ?? 3} tries. If the numbers differ, stop and go to the guest.</p>
      </div>
    );
  }
  if (displayOnly && st?.guest.settings.guestMode === "choosing") {
    return (
      <div className={s.sessionBox}>
        <p>The guest window is display-only. Ask the guest to point at a choice on the card, then record it:</p>
        <div className={s.row}>
          {(["sign", "type", "interpreter", "text_only"] as const).map((c) => (
            <button key={c} type="button" className={s.secondary} onClick={() => void staffAction({ type: "choice_for_guest", choice: c })}>
              Guest chose {c === "text_only" ? "text only" : c}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return null;
}

function Pending({ desk }: { desk: Desk }) {
  const { ui, staffAction } = desk;
  const p = ui.pending;
  if (!p) return null;
  const displayOnly = ui.status?.mode === "mode0" && !ui.status.mode0GuestInput;
  return (
    <div className={s.pendingBox}>
      <p className={s.pendingTitle}>
        {p.simulated && <SimulatedBadge />} Waiting for the guest: {p.kind === "pick" ? "which one did you mean?" : p.kind === "unmatched" ? "not a request we know" : p.kind === "did_you_mean_help" ? "did you mean HELP?" : `"${p.candidates[0]?.text ?? ""}"`}
        {p.testMode && " (test mode, never spoken)"}
      </p>
      {p.signs.length > 0 && (
        <div className={s.tagLine}>
          {p.signs.map((sg, i) => (
            <span key={`${sg.seq ?? "x"}-${i}`} className={s.signChip}>
              <KeyTag token={sg.label} small missed={sg.light === "red"} />
              <TrafficLight light={sg.light} surface="staff" red={sg.red} />
            </span>
          ))}
        </div>
      )}
      {!displayOnly && <p className={s.hint}>Nothing is said aloud until the guest taps Say it on their screen.</p>}
      {displayOnly && (
        <>
          <p className={s.hint}>The guest cannot tap in this mode. Ask them to point at the card on the counter.</p>
          <div className={s.row}>
            {p.candidates.map((c) => (
              <button key={c.candidateId} type="button" className={s.primary} disabled={p.testMode} onClick={() => void staffAction({ type: "confirm_for_guest", proposalId: p.proposalId, candidateId: c.candidateId })}>
                Guest pointed YES: send &ldquo;{c.text}&rdquo;
              </button>
            ))}
            <button type="button" className={s.secondary} onClick={() => void staffAction({ type: "reject_for_guest", proposalId: p.proposalId })}>
              Guest pointed NO
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function LogLine({ e, desk }: { e: LogEntry; desk: Desk }) {
  const spoken = desk.ui.spoken[e.seq];
  switch (e.kind) {
    case "staff":
      return (
        <li className={s.logStaff}>
          <span className={s.logTime}>{clock(e.at)}</span>
          <span className={s.logWho}>You</span>
          <div className={s.logBody}>
            <p className={s.logText}>{e.text}</p>
            <div className={s.tagLine}>
              {e.gloss.map((t, i) => (
                <KeyTag key={i} token={t} small />
              ))}
              {e.gloss.length === 0 && <span className={s.hint}>captions only</span>}
              <span className={s.hint}>
                {e.shownOnDeviceAt ? `shown on device ${clock(e.shownOnDeviceAt, true)}` : "not shown on device yet"}
                {e.captionSource === "voice" && ", from speech recognition"}
                {e.glossSource !== "fixed_intent" && `, gloss: ${e.glossSource.replace(/_/g, " ")}`}
              </span>
            </div>
            {e.guestReply && <p className={s.logReply}>Guest: &ldquo;{GUEST_REPLY_TEXT[e.guestReply]}&rdquo;</p>}
          </div>
        </li>
      );
    case "guest": {
      const plan = e.speak;
      return (
        <li className={s.logGuest}>
          <span className={s.logTime}>{clock(e.at)}</span>
          <span className={s.logWho}>Guest</span>
          <div className={s.logBody}>
            <p className={s.logText}>
              {e.simulated && <SimulatedBadge />} {e.text}
            </p>
            <div className={s.tagLine}>
              {e.signs.map((sg, i) => (
                <span key={i} className={s.signChip}>
                  <KeyTag token={sg.top[0]?.label ?? "NONE"} small missed={sg.light === "red"} />
                  <TrafficLight light={sg.light} surface="staff" red={sg.red} wordless />
                  <span className={s.score}>{sg.top[0] ? sg.top[0].conf.toFixed(2) : ""}</span>
                </span>
              ))}
              {e.source === "phrase" && <span className={s.hint}>picked from the phrase list</span>}
              {e.confirmedBy === "staff_for_guest" && <span className={s.hint}>confirmed by staff after the guest pointed</span>}
            </div>
            <p className={s.hint}>
              {plan.mode === "tts" && (spoken ? (spoken.how === "none" ? "could not be voiced: read it out" : `read aloud ${clock(spoken.at, true)}`) : "reading aloud…")}
              {plan.mode === "none" &&
                (plan.why === "test_mode"
                  ? "test mode: never spoken"
                  : plan.why === "no_local_voice"
                    ? "no on-device voice: read it out"
                    : plan.why === "guest_chose_text"
                      ? "the guest chose Text only for this sentence: do not read it aloud"
                      : "shown as text (the guest turned off reading aloud)")}
              {plan.mode === "local_after_tap" && (spoken ? (spoken.how === "none" ? "no on-device voice: read it out" : `spoken ${clock(spoken.at, true)}`) : "not spoken yet")}
            </p>
            {plan.mode === "local_after_tap" && (
              <button type="button" className={s.small} onClick={() => void desk.voiceLine(e)}>
                {plan.tap === "speak_name" ? "Speak name" : "Read aloud"}
              </button>
            )}
          </div>
        </li>
      );
    }
    case "guest_typed":
      return (
        <li className={s.logGuest}>
          <span className={s.logTime}>{clock(e.at)}</span>
          <span className={s.logWho}>Guest typed</span>
          <div className={s.logBody}>
            <p className={s.logText}>{e.text}</p>
            <p className={s.hint}>{spoken ? (spoken.how === "none" ? "no on-device voice: read it out" : `read aloud ${clock(spoken.at, true)}`) : "not read aloud"}</p>
            <button type="button" className={s.small} onClick={() => void desk.readAloudTyped(e.seq)}>
              Read aloud
            </button>
          </div>
        </li>
      );
    case "guest_reply":
      return (
        <li className={s.logNeutral}>
          <span className={s.logTime}>{clock(e.at)}</span>
          <span>Guest tapped &ldquo;{GUEST_REPLY_TEXT[e.reply]}&rdquo;</span>
        </li>
      );
    case "guest_setting":
    case "system":
      return (
        <li className={s.logNeutral}>
          <span className={s.logTime}>{clock(e.at)}</span>
          <span>{e.text}</span>
        </li>
      );
    case "repeat":
      return (
        <li className={s.logNeutral}>
          <span className={s.logTime}>{clock(e.at)}</span>
          <span>
            Asked the guest to sign again ({e.reason === "none_sign" ? "camera saw no known sign" : e.reason === "framing" ? "camera missed it (framing)" : e.reason === "no_candidate" ? "no matching request" : "low model scores"})
            {e.recognizerSaidRepeat && "; recognizer suggested a repeat"}
          </span>
        </li>
      );
  }
}

function Middle({ desk }: { desk: Desk }) {
  const { ui } = desk;
  const logRef = useRef<HTMLOListElement>(null);
  // Newest at the bottom: follow new lines unless staff scrolled up to read older ones.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [ui.log.length]);
  const liveSimulated = ui.live.some((l) => l.simulated);
  const latestGuest = [...ui.log].reverse().find((e): e is Extract<LogEntry, { kind: "guest" }> => e.kind === "guest") ?? null;
  return (
    <section className={`${s.column} ${s.middle}`} aria-labelledby="log-title" tabIndex={0}>
      <SessionControls desk={desk} />
      <h2 id="log-title" className={s.colTitle}>
        Conversation <span className={s.hint}>(memory only, wiped at End guest)</span>
      </h2>
      <ol className={s.log} ref={logRef} aria-live="polite" aria-relevant="additions" aria-label="Conversation log" tabIndex={0}>
        {ui.log.length === 0 && <li className={s.hint}>Nothing yet. Start with a quick reply.</li>}
        {ui.log.map((e) => (
          <LogLine key={`${e.kind}-${e.seq}-${e.at}`} e={e} desk={desk} />
        ))}
      </ol>
      <Pending desk={desk} />
      <div className={s.liveStrip} aria-label="Live signs">
        <span className={s.liveLabel}>Live signs</span>
        {ui.live.length === 0 && !ui.capture && <span className={s.hint}>none yet</span>}
        {liveSimulated && <SimulatedBadge />}
        {ui.live.map(({ sign }, i) => (
          <span key={`${sign.seq}-${i}`} className={s.signChip}>
            <KeyTag token={sign.top[0]?.label ?? "NONE"} small missed={sign.light === "red"} />
            <TrafficLight light={sign.light} surface="staff" red={sign.red} />
            <span className={s.score}>{sign.top[0]?.conf.toFixed(2)}</span>
          </span>
        ))}
        {ui.capture && (
          <span className={s.hint} role="status">
            {ui.capture.phase === "processing" ? "reading the sign…" : `recording: ${ui.capture.countdown ?? 0} s countdown, ${ui.capture.duration ?? 2} s window`}
          </span>
        )}
        {ui.repeats.count > 0 && <span className={s.hint}>repeats this guest: {ui.repeats.count}</span>}
      </div>
      {latestGuest && (
        <div className={s.guestSays}>
          <p className={s.hint}>Guest says</p>
          <p className={s.guestSaysText}>&ldquo;{latestGuest.text}&rdquo;</p>
          <div className={s.row}>
            <span className={s.hint}>
              sent {latestGuest.confirmedBy === "guest" ? "by the guest" : "by staff for the guest"} {clock(latestGuest.at)}
            </span>
            {latestGuest.speak.mode === "tts" && (
              <button type="button" className={s.small} onClick={() => void desk.voiceLine(latestGuest, true)}>
                Speak again
              </button>
            )}
          </div>
          {latestGuest.signs.length > 0 && <p className={s.hint}>Signs: {latestGuest.signs.map((x) => tagText(x.top[0]?.label ?? "NONE")).join(" ")}</p>}
        </div>
      )}
    </section>
  );
}
