"use client";
// P4 (builder B): the guest screen (docs/app-plan.md sections 4.3 to 4.6, BIGTECH_TO_PRODUCT BN-1 to BN-5).
//
// Rules this file keeps (SES-11, GST-9, SPK-6, A11Y-3, A11Y-5):
// - no camera, microphone, storage or service-worker code; every guest string is rendered as text;
// - the guest never sees a score, a percentage, "sure" or "unclear"; misses name the camera;
// - "Get staff now" has its own full-width row on every screen; Send, Fix and Help sit low;
// - one polite and one assertive live region; a new proposal takes focus only when the guest is
//   not typing;
// - display-only Mode 0 (hello.displayOnly) renders no tappable control at all;
// - BN-1: a sentence is confirmed with three equal buttons, "Say it", "Text only" and "Fix"; nothing
//   is voiced at the desk before "Say it". A runner-up or a pick becomes a sentence the guest then
//   confirms the same way;
// - BN-5: the guest's own record of the conversation lives in this page's memory only.
import { useEffect, useMemo, useRef, useState } from "react";
import { KeyTag, SimulatedBadge, TrafficLight } from "@/components/app/KeyTag";
import { GUEST_PHRASES, nameProblem, typedProblem } from "@/components/app/displayVocab";
import {
  END_REASON_GUEST,
  END_SCREEN_PENDING_NOTE,
  END_SCREEN_STORAGE_NOTE,
  FRAMING_GUIDANCE,
  GUEST_HONEST_LINES,
  GUEST_NOTICE,
  GUEST_NOTICE_EXTRA,
  GUEST_REPLY_TEXT,
  GUEST_SCROLLBACK_HINT,
  HELP_LABEL,
  LIGHT_WORDS_GUEST,
  LIMITS,
  REPEAT_TEXT,
  SIGN_CARD_TEXT,
  SPEECH_CAPTION_NOTE,
  VRI_UNSET_TEXT,
  type Candidate,
  type GuestIntentId,
  type GuestProposal,
  type GuestReplyKind,
  type GuestSignView,
  type VriInfo,
} from "@/lib/app/types";
import AvatarStage from "./AvatarStage";
import s from "./guest.module.css";
import { useGuestSession, type ActionOutcome, type GuestUi, type RecordItem } from "./useGuestSession";

type Session = ReturnType<typeof useGuestSession>;

/** Caption size steps (BN-3). Memory only; a new page starts at the standard size. */
type TextSize = 0 | 1 | 2;
const TEXT_SIZE_WORDS: Record<TextSize, string> = { 0: "Standard", 1: "Large", 2: "Largest" };

/** Order of the repair replies under the latest caption (plan C2-11 plus BN-3). */
const REPLY_ORDER: GuestReplyKind[] = ["please_repeat", "slower", "please_type", "show_on_paper", "dont_understand", "wait_please"];

const isTyping = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
};

/** Kiosk inputs (every team-owned device): no autocomplete, autocorrect, capitalisation or spellcheck (AS-8). */
const kioskInput = (kiosk: boolean) =>
  kiosk ? ({ autoComplete: "off", autoCorrect: "off", autoCapitalize: "off", spellCheck: false } as const) : {};

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/* ------------------------------------------------------------------ */

export default function GuestApp() {
  const session = useGuestSession();
  const { ui, hidden } = session;
  const displayOnly = ui.hello?.displayOnly ?? false;
  const [textSize, setTextSize] = useState<TextSize>(0);
  const finishRef = useRef<HTMLDialogElement>(null);

  if (hidden) {
    // AS-7: nothing of the conversation while the page is hidden; restored from memory on return.
    return (
      <main className={s.root}>
        <div className={s.center}>
          <p className={s.brand}>SignBridge front desk</p>
        </div>
      </main>
    );
  }

  const ui2: Ui = { session, textSize, setTextSize, askFinish: () => finishRef.current?.showModal() };

  return (
    <main className={s.root} data-display-only={displayOnly || undefined} data-text-size={textSize}>
      <LiveRegions ui={ui} />
      <GuestBody u={ui2} />
      <HelpRow session={session} />
      {!displayOnly && <FinishDialog dialogRef={finishRef} onFinish={() => void session.finish()} />}
    </main>
  );
}

type Ui = { session: Session; textSize: TextSize; setTextSize: (v: TextSize) => void; askFinish: () => void };

function GuestBody({ u }: { u: Ui }) {
  const { ui } = u.session;
  const displayOnly = ui.hello?.displayOnly ?? false;

  if (ui.conn === "ended" && ui.end) return <EndScreen reason={ui.end.reason} pendingLost={ui.end.pendingLost} />;
  if (ui.conn === "connecting") return <Message title="Connecting to the front desk" />;
  if (ui.conn === "no_session") return <Message title="Ask the front desk to connect this screen." />;
  if (ui.conn === "link_used")
    return <Message title="This link was already used or has expired." body="Ask the front desk to connect this screen." />;
  if (ui.conn === "lost") return <Message title="Ask the desk to reconnect this screen." body="If you need help now, wave to the desk." />;
  if (ui.paused) return <Message title="Please wait, the desk is checking this screen." body={`Only "${HELP_LABEL}" works until the desk has checked it.`} />;

  // Pairing on a separate device (Tier 1): the desk reads the number off this screen (C2-24).
  if (ui.hello && ui.hello.check && !ui.pairedWith && ui.hello.mode !== "mode0") {
    return (
      <div className={s.center}>
        <p className={s.brand}>SignBridge front desk</p>
        <h1 className={s.title}>The desk is connecting this screen. This takes about a minute.</h1>
        <p className={s.checkCode} aria-label={`Number ${ui.hello.check.split("").join(" ")}`}>
          {ui.hello.check.slice(0, 3)} {ui.hello.check.slice(3)}
        </p>
        <p className={s.muted}>(the desk reads this number off this screen)</p>
      </div>
    );
  }

  return (
    <>
      <Header u={u} />
      {ui.warning && <TimeWarning warning={ui.warning} />}
      {ui.notice && <Notice text={ui.notice.text} at={ui.notice.at} />}
      {ui.settings.guestMode === "choosing" ? (
        displayOnly ? <DisplayOnlyChoices /> : <FirstScreen session={u.session} />
      ) : (
        <Conversation u={u} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Frame: header, live regions, Help row, small messages               */
/* ------------------------------------------------------------------ */

function Header({ u }: { u: Ui }) {
  const { ui } = u.session;
  const displayOnly = ui.hello?.displayOnly ?? false;
  return (
    <header className={s.header}>
      <p className={s.brand}>SignBridge front desk</p>
      {ui.pairedWith && <p className={s.muted}>Paired with {ui.pairedWith}</p>}
      {!displayOnly && ui.settings.guestMode !== "choosing" && <MoreMenu u={u} />}
    </header>
  );
}

function LiveRegions({ ui }: { ui: GuestUi }) {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const latestCaption = ui.captions[0]?.cap;
  const lastLive = ui.live[ui.live.length - 1];

  useEffect(() => {
    if (latestCaption) setPolite(`Front desk said: ${latestCaption.text}`);
  }, [latestCaption]);
  useEffect(() => {
    if (lastLive) setPolite(`Camera read ${lastLive.sign.label}, ${LIGHT_WORDS_GUEST[lastLive.sign.light]}`);
  }, [lastLive]);
  useEffect(() => {
    if (ui.pending) setPolite(proposalHeading(ui.pending));
  }, [ui.pending]);
  useEffect(() => {
    if (ui.repeat) setPolite(REPEAT_TEXT);
  }, [ui.repeat]);
  useEffect(() => {
    if (ui.echo) setPolite(`Sent to the front desk: ${ui.echo.text}`);
  }, [ui.echo]);
  useEffect(() => {
    if (ui.framing && ui.settings.guestMode === "sign") setPolite(FRAMING_GUIDANCE[ui.framing]);
  }, [ui.framing, ui.settings.guestMode]);
  useEffect(() => {
    if (ui.notice) setPolite(ui.notice.text);
  }, [ui.notice]);
  useEffect(() => {
    if (ui.help.state === "sent") setAssertive("Staff has been alerted.");
    if (ui.help.state === "acked") setAssertive("Staff is coming.");
    if (ui.help.state === "failed") setAssertive("This screen could not reach the desk. Wave or knock at the desk.");
  }, [ui.help.state]);
  useEffect(() => {
    if (ui.warning) setAssertive("This session will end soon unless the desk keeps it open.");
  }, [ui.warning]);
  useEffect(() => {
    if (ui.end) setAssertive(`This conversation has ended. ${END_REASON_GUEST[ui.end.reason]}`);
  }, [ui.end]);

  return (
    <>
      <div className="sr-only" aria-live="polite" role="status">
        {polite}
      </div>
      <div className="sr-only" aria-live="assertive" role="alert">
        {assertive}
      </div>
    </>
  );
}

function HelpRow({ session }: { session: Session }) {
  const { ui, emergency } = session;
  const now = useNow();
  const displayOnly = ui.hello?.displayOnly ?? false;
  if (displayOnly || ui.conn === "lost" || ui.conn === "no_session" || ui.conn === "link_used") {
    return (
      <footer className={s.helpRow}>
        <p className={s.waveText}>Need staff? Wave to the desk.</p>
      </footer>
    );
  }
  const sentAt = ui.help.at;
  const noReply = ui.help.state === "sent" && sentAt !== null && now - sentAt > LIMITS.emergencyNoAckMs;
  return (
    <footer className={s.helpRow} data-state={ui.help.state}>
      {ui.help.state !== "none" && (
        <p className={s.helpStatus}>
          {ui.help.state === "sent" && "Staff has been alerted."}
          {ui.help.state === "acked" && "Staff is coming."}
          {ui.help.state === "failed" && "This screen could not reach the desk. Wave or knock at the desk."}
          {noReply && " No reply yet. Wave or knock at the desk."}
        </p>
      )}
      <button type="button" className={s.helpButton} onClick={() => void emergency()}>
        <svg aria-hidden="true" viewBox="0 0 24 24" className={s.helpIcon}>
          <path d="M12 2.5 1.8 20.5h20.4L12 2.5Zm0 6v6m0 2.6v.1" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {HELP_LABEL}
      </button>
    </footer>
  );
}

function Message({ title, body }: { title: string; body?: string }) {
  return (
    <div className={s.center}>
      <p className={s.brand}>SignBridge front desk</p>
      <h1 className={s.title}>{title}</h1>
      {body && <p className={s.lead}>{body}</p>}
    </div>
  );
}

function Notice({ text, at }: { text: string; at: number }) {
  const now = useNow();
  if (now - at > 8_000) return null;
  return <p className={s.notice}>{text}</p>;
}

function TimeWarning({ warning }: { warning: NonNullable<GuestUi["warning"]> }) {
  const now = useNow();
  const left = Math.max(0, Math.round((warning.until - now) / 1000));
  if (left === 0) return null;
  const when = left >= 90 ? `${Math.round(left / 60)} minutes` : `${left} seconds`;
  return (
    <p className={s.timeWarning}>
      This session will end soon: in {when}, unless the desk keeps it open.{" "}
      <span className={s.timeWarningSub}>{warning.kind === "cap" ? "It has reached the time limit for one conversation." : "Nobody at the desk has used it for a while."}</span>
    </p>
  );
}

function EndScreen({ reason, pendingLost }: { reason: keyof typeof END_REASON_GUEST; pendingLost: boolean }) {
  return (
    <div className={s.center}>
      <h1 className={s.title}>This conversation has ended.</h1>
      <p className={s.lead}>{END_REASON_GUEST[reason]}</p>
      {pendingLost && <p className={s.lead}>{END_SCREEN_PENDING_NOTE}</p>}
      <p className={s.muted}>{END_SCREEN_STORAGE_NOTE}</p>
      <p className={s.lead}>If you need anything else, wave to the front desk.</p>
    </div>
  );
}

function FinishDialog({ dialogRef, onFinish }: { dialogRef: React.RefObject<HTMLDialogElement | null>; onFinish: () => void }) {
  return (
    <dialog ref={dialogRef} className={s.dialog} aria-labelledby="finish-title">
      <h2 id="finish-title" className={s.dialogTitle}>
        End and delete this conversation?
      </h2>
      <p className={s.lead}>Everything on this screen will be cleared, and the desk&apos;s copy is erased too.</p>
      <div className={s.buttonRow}>
        <button
          type="button"
          className={s.primary}
          onClick={() => {
            dialogRef.current?.close();
            onFinish();
          }}
        >
          Yes, end and delete
        </button>
        <button type="button" className={s.secondary} autoFocus onClick={() => dialogRef.current?.close()}>
          Keep talking
        </button>
      </div>
    </dialog>
  );
}

/* ------------------------------------------------------------------ */
/* First screen (plan 4.4, BN-2)                                       */
/* ------------------------------------------------------------------ */

function FirstScreen({ session }: { session: Session }) {
  const { ui, act, requestInterpreter } = session;
  const [error, setError] = useState<string | null>(null);
  const speakAloud = ui.settings.speakAloud;

  const choose = async (choice: "sign" | "type" | "interpreter" | "text_only") => {
    setError(null);
    const r = await act({ type: "guest_choice", choice });
    if (!r.ok) return setError(r.message);
    if (choice === "interpreter") await requestInterpreter();
  };

  return (
    <div className={s.first}>
      <h1 className={s.title}>How would you like to talk with the front desk?</h1>
      <div className={s.choices}>
        <button type="button" className={s.choice} disabled={!ui.signingAvailable} onClick={() => void choose("sign")}>
          <ChoiceIcon kind="sign" />
          <span className={s.choiceTitle}>Sign</span>
          <span className={s.choiceText}>
            {ui.signingAvailable ? SIGN_CARD_TEXT : "Signing is not available right now. Please type or ask for an interpreter."}
          </span>
        </button>
        <button type="button" className={s.choice} onClick={() => void choose("type")}>
          <ChoiceIcon kind="type" />
          <span className={s.choiceTitle}>Type</span>
          <span className={s.choiceText}>Type a message, or tap one of 20 common requests.</span>
        </button>
        <button type="button" className={s.choice} onClick={() => void choose("interpreter")}>
          <ChoiceIcon kind="interpreter" />
          <span className={s.choiceTitle}>Ask for a human interpreter</span>
          <span className={s.choiceText}>The desk arranges a sign language interpreter. This may take time.</span>
        </button>
        <button type="button" className={s.choice} onClick={() => void choose("text_only")}>
          <ChoiceIcon kind="text" />
          <span className={s.choiceTitle}>Text only</span>
          <span className={s.choiceText}>Read the desk&apos;s words as text, with no avatar.</span>
        </button>
      </div>
      {error && <p className={s.error}>{error}</p>}
      <label className={s.check}>
        <input type="checkbox" checked={speakAloud} onChange={(e) => void act({ type: "prefs", speakAloud: e.target.checked })} />
        <span>
          Read my sentences aloud at the desk. <span className={s.muted}>People nearby will hear it. You still choose each time.</span>
        </span>
      </label>
      <ul className={s.honest}>
        <li>{GUEST_HONEST_LINES.camera}</li>
        <li>{GUEST_HONEST_LINES.keeps}</li>
        <li>{GUEST_HONEST_LINES.mistakes}</li>
      </ul>
      <AboutScreen emergencyNote={ui.hello?.emergencyNote ?? ""} />
    </div>
  );
}

/** Small line icons for the four equal choices; decoration only, the words carry the meaning. */
function ChoiceIcon({ kind }: { kind: "sign" | "type" | "interpreter" | "text" }) {
  const paths: Record<typeof kind, string> = {
    sign: "M7 21v-6.5L4.6 9.8a1.4 1.4 0 0 1 2.4-1.4L9 11V4.5a1.3 1.3 0 0 1 2.6 0V10m0-5.8a1.3 1.3 0 0 1 2.6 0V10m0-4.3a1.3 1.3 0 0 1 2.6 0V11m0-3a1.3 1.3 0 0 1 2.6 0v6.5c0 3.6-2.4 6.5-6 6.5",
    type: "M3 7h18v10H3zM6 10h1m3 0h1m3 0h1m3 0h1M7 14h10",
    interpreter: "M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 9c0-3 2.2-5 5-5s5 2 5 5M16 8.5a2.5 2.5 0 1 0 0-5M17 12.6c2 .5 3.5 2.3 3.5 4.9",
    text: "M4 6h16M4 10h16M4 14h11M4 18h8",
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={s.choiceIcon}>
      <path d={paths[kind]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AboutScreen({ emergencyNote }: { emergencyNote: string }) {
  return (
    <>
      <details className={s.about}>
        <summary>About this screen</summary>
        <p>{GUEST_NOTICE}</p>
        {GUEST_NOTICE_EXTRA.map((t) => (
          <p key={t}>{t}</p>
        ))}
      </details>
      {emergencyNote && <p className={s.muted}>{emergencyNote}</p>}
    </>
  );
}

function DisplayOnlyChoices() {
  return (
    <div className={s.first}>
      <h1 className={s.title}>The desk will ask how you want to talk. Point to one:</h1>
      <div className={s.choices} aria-label="Choices on the card at the desk">
        {["Sign", "Type", "Interpreter", "Text only"].map((c) => (
          <div key={c} className={`${s.choice} ${s.choiceStatic}`}>
            <span className={s.choiceTitle}>{c}</span>
          </div>
        ))}
      </div>
      <p className={s.lead}>{SIGN_CARD_TEXT}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Conversation (plan 4.5)                                             */
/* ------------------------------------------------------------------ */

function Conversation({ u }: { u: Ui }) {
  const { ui } = u.session;
  const displayOnly = ui.hello?.displayOnly ?? false;
  return (
    // While a sentence waits for the guest, a phone shows it first, within thumb reach (plan 4.5).
    <div className={s.conversation} data-pending={(ui.pending !== null && !displayOnly) || undefined}>
      <DeskSaid session={u.session} />
      <section className={s.you} aria-labelledby="you-title">
        {displayOnly ? <DisplayOnlyYou ui={ui} /> : <YouPanel session={u.session} />}
      </section>
      {!displayOnly && <Scrollback record={ui.record} onFinish={u.askFinish} />}
    </div>
  );
}

function DeskSaid({ session }: { session: Session }) {
  const { ui, act, captionsSeen } = session;
  const displayOnly = ui.hello?.displayOnly ?? false;
  const latest = ui.captions[0] ?? null;
  const [playKey, setPlayKey] = useState(0);
  const [replySent, setReplySent] = useState<string | null>(null);
  const textOnly = ui.settings.guestMode === "text_only";
  const showAvatar = ui.settings.showAvatar && !textOnly;

  useEffect(() => {
    setPlayKey((k) => k + 1);
    setReplySent(null);
  }, [latest?.cap.id]);

  const reply = async (kind: GuestReplyKind) => {
    const r = await act({ type: "guest_reply", reply: kind, captionId: latest?.cap.id ?? null });
    setReplySent(r.ok ? `Sent to the desk: "${GUEST_REPLY_TEXT[kind]}"` : r.message);
  };

  return (
    <section className={s.deskSaid} aria-labelledby="desk-title" onPointerDown={captionsSeen} onScroll={captionsSeen} onFocus={captionsSeen}>
      <h2 id="desk-title" className={s.sectionTitle}>
        Front desk said
      </h2>
      {ui.captions.length === 0 && <p className={s.muted}>The desk&apos;s words will appear here.</p>}
      {ui.captions.map((c, i) => (
        <div key={c.cap.id} className={i === 0 ? s.captionLatest : s.captionOld} data-new={(i === 0 && c.isNew) || undefined}>
          <p className={i === 0 ? s.captionText : s.captionTextOld}>
            {c.cap.text}
            {i === 0 && c.isNew && <span className={s.newMark}>New</span>}
          </p>
          {c.cap.captionSource === "voice" && <p className={s.small}>{SPEECH_CAPTION_NOTE}</p>}
        </div>
      ))}
      {latest && !displayOnly && !textOnly && (
        <div className={s.avatarControls}>
          {showAvatar && latest.cap.gloss.length > 0 && (
            <button type="button" className={s.chip} onClick={() => setPlayKey((k) => k + 1)}>
              <svg aria-hidden="true" viewBox="0 0 24 24" className={s.chipIcon}>
                <path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Show again
            </button>
          )}
          <button type="button" className={s.chip} aria-pressed={!ui.settings.showAvatar} onClick={() => void act({ type: "prefs", showAvatar: !ui.settings.showAvatar })}>
            {ui.settings.showAvatar ? "Captions only" : "Show the avatar"}
          </button>
        </div>
      )}
      <AvatarStage caption={latest?.cap ?? null} playKey={playKey} showAvatar={showAvatar} interactive={!displayOnly} />
      {latest && !displayOnly && (
        <div className={s.repairRow} role="group" aria-label="Ask the desk">
          {REPLY_ORDER.map((k) => (
            <button key={k} type="button" className={s.repairButton} onClick={() => void reply(k)}>
              {GUEST_REPLY_TEXT[k].replace(/\.$/, "")}
            </button>
          ))}
        </div>
      )}
      {replySent && (
        <p className={s.small} role="status">
          {replySent}
        </p>
      )}
    </section>
  );
}

function YouPanel({ session }: { session: Session }) {
  const { ui } = session;
  const mode = ui.settings.guestMode;
  return (
    <>
      <h2 id="you-title" className={s.sectionTitle}>
        You
      </h2>
      {ui.pending ? (
        <ProposalView key={ui.pending.proposalId} session={session} proposal={ui.pending} />
      ) : (
        <>
          {mode === "sign" && <SignPanel session={session} />}
          {(mode === "type" || mode === "text_only") && <TypePanel session={session} />}
          {mode === "interpreter" && <InterpreterPanel session={session} />}
        </>
      )}
    </>
  );
}

/** True when the guest allowed reading aloud and is not in Text only mode (C2-22). */
const canSpeak = (ui: GuestUi) => ui.settings.speakAloud && ui.settings.guestMode !== "text_only";

function SignRow({ signs, simulated }: { signs: GuestSignView[]; simulated: boolean }) {
  return (
    <ul className={s.signRow} aria-label="Signs the camera read">
      {simulated && (
        <li>
          <SimulatedBadge />
        </li>
      )}
      {signs.map((sg, i) => (
        <li key={`${sg.seq ?? "x"}-${i}`} className={s.signItem}>
          <KeyTag token={sg.label === "NONE" ? "no sign" : sg.label} missed={sg.light === "red"} />
          <TrafficLight light={sg.light} surface="guest" />
        </li>
      ))}
    </ul>
  );
}

function SignPanel({ session }: { session: Session }) {
  const { ui, act } = session;
  const [dismissedRepeat, setDismissedRepeat] = useState<GuestUi["repeat"]>(null);
  const isMode0 = ui.hello?.mode === "mode0";

  if (!ui.signingAvailable) {
    return (
      <div className={s.stack}>
        <p className={s.lead}>Signing is not available right now. Please type or ask for an interpreter.</p>
        <button type="button" className={s.primary} onClick={() => void act({ type: "guest_choice", choice: "type" })}>
          Type instead
        </button>
      </div>
    );
  }

  const repeat = ui.repeat && ui.repeat !== dismissedRepeat ? ui.repeat : null;
  const framingNotOk = ui.framing && ui.framing !== "OK";
  // BT-26: after two framing misses in a row, or three misses of any kind, typing comes first.
  const typeFirst = repeat ? repeat.streak >= 3 || (repeat.streak >= 2 && repeat.reason === "framing") : false;

  return (
    <div className={s.stack}>
      <p className={s.lead}>
        {isMode0 ? "Signing is on. Face the desk camera, with both hands free." : "Signing is on. Put the phone in the stand so both hands are free."}
      </p>
      <p className={framingNotOk ? s.framingAlert : s.framingOk}>
        <FramingIcon ok={!framingNotOk} />
        {FRAMING_GUIDANCE[ui.framing ?? "OK"]}
      </p>

      {ui.live.length > 0 && !repeat && !ui.echo && (
        <div className={s.liveBlock}>
          <h3 className={s.subTitle}>Signs the camera read</h3>
          <SignRow signs={ui.live.map((l) => l.sign)} simulated={ui.live.some((l) => l.simulated)} />
        </div>
      )}

      {repeat && (
        <div className={s.card}>
          <p className={s.cardText}>{REPEAT_TEXT}</p>
          {repeat.signs.length > 0 && <SignRow signs={repeat.signs} simulated={false} />}
          {repeat.framingText && <p className={s.framingAlert}>{repeat.framingText}</p>}
          <div className={s.buttonRow}>
            {typeFirst ? (
              <>
                <button type="button" className={s.primary} onClick={() => void act({ type: "guest_choice", choice: "type" })}>
                  Type instead
                </button>
                <button type="button" className={s.secondary} onClick={() => setDismissedRepeat(repeat)}>
                  Sign again
                </button>
              </>
            ) : (
              <>
                <button type="button" className={s.primary} onClick={() => setDismissedRepeat(repeat)}>
                  Sign again
                </button>
                <button type="button" className={s.secondary} onClick={() => void act({ type: "guest_choice", choice: "type" })}>
                  Type instead
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {ui.echo && <Echo echo={ui.echo} />}

      <WhatCanISign />
      <button type="button" className={s.quiet} onClick={() => void act({ type: "stop_signing" })}>
        Stop signing
      </button>
    </div>
  );
}

function FramingIcon({ ok }: { ok: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={s.framingIcon}>
      {ok ? (
        <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M4 8V4h4m8 0h4v4m0 8v4h-4m-8 0H4v-4M12 9v4m0 3v.1" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function WhatCanISign() {
  return (
    <details className={s.about}>
      <summary>What can I sign?</summary>
      <ul className={s.phraseKey}>
        {GUEST_PHRASES.map((p) => (
          <li key={p.id}>
            <span className={s.tagRow}>
              {p.signs.map((sg) => (
                <KeyTag key={sg} token={sg} small />
              ))}
              {p.needsName && <span className={s.small}>then type your name</span>}
            </span>
            <span>{p.text}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Echo({ echo }: { echo: NonNullable<GuestUi["echo"]> }) {
  const how =
    echo.delivery === "spoken"
      ? "Read aloud at the desk."
      : echo.delivery === "shown"
        ? "Shown as text at the desk. Nothing was said aloud."
        : "Shown on the desk screen first. Staff choose when to read it aloud.";
  return (
    <div className={s.echo} role="status">
      <p className={s.cardTitle}>Sent to the front desk</p>
      <p className={s.cardText}>The desk received: &ldquo;{echo.text}&rdquo;</p>
      <p className={s.small}>{how}</p>
    </div>
  );
}

function proposalHeading(p: GuestProposal): string {
  switch (p.kind) {
    case "proposal":
      return p.candidates[0] ? `"${p.candidates[0].text}"` : "Is this what you meant?";
    case "did_you_mean":
      return p.candidates[0] ? `Did you mean: "${p.candidates[0].text}"` : "Did you mean...?";
    case "did_you_mean_help":
      return "Did you mean HELP? Staff will come to you.";
    case "pick":
      return "Which one did you mean?";
    case "unmatched":
      return `The camera read: ${p.signs.map((x) => x.label).join(" ")}. That doesn't match a request we know.`;
  }
}

/* ------------------------------------------------------------------ */
/* Confirm before speaking (BN-1)                                      */
/* ------------------------------------------------------------------ */

type Confirmable = { text: string; needsName: boolean };
type SendHow = { voice: boolean; name?: string };

/**
 * The one confirmation every sentence goes through: the exact sentence, the signs it came from, and
 * three equal buttons. "Say it" lets the desk read it aloud; "Text only" shows it at the desk with no
 * voice; "Fix" never re-runs recognition by itself (BN-1).
 */
function ConfirmCard(props: {
  ui: GuestUi;
  item: Confirmable;
  signs: GuestSignView[] | null;
  simulated: boolean;
  testMode: boolean;
  headingRef?: React.RefObject<HTMLHeadingElement | null>;
  heading?: string;
  onSend: (how: SendHow) => Promise<ActionOutcome>;
  fixOptions: { label: string; run: () => void }[];
}) {
  const { ui, item, signs, simulated, testMode } = props;
  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const speak = canSpeak(ui);

  const send = async (voice: boolean) => {
    let typedName: string | undefined;
    if (item.needsName) {
      const problem = nameProblem(name);
      if (problem) return setNameErr(problem);
      typedName = name.normalize("NFC").trim();
    }
    setBusy(true);
    setError(null);
    const r = await props.onSend({ voice, ...(typedName ? { name: typedName } : {}) });
    setBusy(false);
    if (!r.ok) {
      if (r.field === "name") setNameErr(r.message);
      else setError(r.message);
    }
  };

  const sentence = item.needsName ? `My name is ${name.trim() || "..."}` : item.text;

  return (
    <div className={s.confirm}>
      {props.heading && <p className={s.small}>{props.heading}</p>}
      <h3 ref={props.headingRef} tabIndex={-1} className={s.proposalHeading}>
        &ldquo;{sentence}&rdquo;
      </h3>
      {signs && signs.length > 0 && <SignRow signs={signs} simulated={simulated} />}
      {testMode && <p className={s.framingAlert}>Test mode: these signs were invented by a test program and will not be spoken.</p>}
      {item.needsName && <NameField name={name} setName={setName} error={nameErr} setError={setNameErr} kiosk={ui.hello?.kiosk ?? true} />}
      {signs && signs.length > 0 && <p className={s.small}>{GUEST_HONEST_LINES.face}</p>}
      <div className={s.confirmButtons} data-count={speak ? 3 : 2}>
        {speak && (
          <button type="button" className={s.primary} disabled={busy || testMode} onClick={() => void send(true)}>
            Say it
          </button>
        )}
        <button type="button" className={speak ? s.secondary : s.primary} disabled={busy || testMode} onClick={() => void send(false)}>
          {speak ? "Text only" : "Send as text"}
        </button>
        <button type="button" className={s.secondary} disabled={busy} aria-expanded={fixOpen} onClick={() => setFixOpen((v) => !v)}>
          Fix
        </button>
      </div>
      <p className={s.small}>
        {speak
          ? item.needsName
            ? "Say it: your name appears on the desk screen, and staff read it aloud on this laptop's own voice. Text only: it is never read aloud."
            : "Say it: the desk reads this sentence aloud. Text only: it appears on the desk screen with no voice."
          : "Reading aloud is off. The sentence appears on the desk screen with no voice."}
      </p>
      {fixOpen && (
        <div className={s.buttonRow} role="group" aria-label="Fix">
          {props.fixOptions.map((f) => (
            <button key={f.label} type="button" className={s.secondary} onClick={f.run}>
              {f.label}
            </button>
          ))}
        </div>
      )}
      {error && <p className={s.error}>{error}</p>}
    </div>
  );
}

function ProposalView({ session, proposal }: { session: Session; proposal: GuestProposal }) {
  const { ui, act, emergency } = session;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [chosen, setChosen] = useState<Candidate | null>(proposal.kind === "proposal" ? (proposal.candidates[0] ?? null) : null);
  const [error, setError] = useState<string | null>(null);
  const first = proposal.candidates[0] ?? null;

  useEffect(() => {
    if (!isTyping()) headingRef.current?.focus();
  }, [proposal.proposalId, chosen]);

  const fix = async (action: "sign_again" | "type" | "interpreter" | "not_this") => {
    setError(null);
    const r = await act({ type: "guest_fix", proposalId: proposal.proposalId, action });
    if (!r.ok) setError(r.message);
  };
  const confirm = (c: Candidate) => (how: SendHow) =>
    act({ type: "guest_confirm", proposalId: proposal.proposalId, candidateId: c.candidateId, voice: how.voice, ...(how.name ? { name: how.name } : {}) });

  const fixOptions = [
    ...(proposal.candidates.length > 1 && chosen ? [{ label: "Choose another", run: () => setChosen(null) }] : []),
    { label: "Type instead", run: () => void fix("type") },
    { label: "Sign again", run: () => void fix("sign_again") },
    { label: "Ask for an interpreter", run: () => void fix("interpreter") },
  ];

  // A sentence is chosen (a confident proposal, or the guest picked one): confirm it (BN-1).
  if (chosen && proposal.kind !== "did_you_mean_help") {
    return (
      <div className={s.card} data-kind={proposal.kind}>
        <ConfirmCard
          ui={ui}
          item={chosen}
          signs={proposal.signs}
          simulated={proposal.simulated}
          testMode={proposal.testMode}
          headingRef={headingRef}
          heading={proposal.kind === "proposal" ? "The camera read:" : "You chose:"}
          onSend={confirm(chosen)}
          fixOptions={fixOptions}
        />
        {error && <p className={s.error}>{error}</p>}
      </div>
    );
  }

  return (
    <div className={s.card} data-kind={proposal.kind}>
      {proposal.signs.length > 0 && <SignRow signs={proposal.signs} simulated={proposal.simulated} />}
      {proposal.testMode && <p className={s.framingAlert}>Test mode: these signs were invented by a test program and will not be spoken.</p>}
      <h3 ref={headingRef} tabIndex={-1} className={s.proposalHeading}>
        {proposalHeading(proposal)}
      </h3>

      {proposal.kind === "did_you_mean" && first && (
        <div className={s.buttonRow}>
          <button type="button" className={s.primary} onClick={() => setChosen(first)}>
            Yes
          </button>
          <button type="button" className={s.secondary} onClick={() => void fix("sign_again")}>
            No, sign again
          </button>
          <button type="button" className={s.secondary} onClick={() => void fix("type")}>
            Type instead
          </button>
        </div>
      )}

      {proposal.kind === "did_you_mean_help" && (
        <div className={s.buttonRow}>
          <button
            type="button"
            className={s.alarmButton}
            onClick={() => {
              // HELP never alerts without this tap; the alert itself is the emergency action (never refused).
              void emergency();
              // The guest's tap is the consent; it is read aloud only if they allow reading aloud.
              if (first && !proposal.testMode) void confirm(first)({ voice: canSpeak(ui) });
              else void fix("not_this");
            }}
          >
            Yes, get staff
          </button>
          <button type="button" className={s.secondary} onClick={() => void fix("not_this")}>
            No
          </button>
        </div>
      )}

      {(proposal.kind === "pick" || proposal.kind === "unmatched") && (
        <div className={s.stack}>
          {proposal.kind === "unmatched" && proposal.candidates.length > 0 && <p className={s.small}>Nearest requests we know:</p>}
          <div className={s.pickList}>
            {proposal.candidates.map((c) => (
              <button key={c.candidateId} type="button" className={s.sentenceButton} onClick={() => setChosen(c)}>
                {c.needsName ? "My name is ..." : c.text}
              </button>
            ))}
          </div>
          <p className={s.small}>None of these:</p>
          <div className={s.buttonRow}>
            <button type="button" className={s.secondary} onClick={() => void fix("type")}>
              Type
            </button>
            <button type="button" className={s.secondary} onClick={() => void fix("sign_again")}>
              Sign again
            </button>
            <button type="button" className={s.secondary} onClick={() => void fix("interpreter")}>
              Interpreter
            </button>
          </div>
        </div>
      )}
      {error && <p className={s.error}>{error}</p>}
    </div>
  );
}

function NameField(props: { name: string; setName: (v: string) => void; error: string | null; setError: (v: string | null) => void; kiosk: boolean }) {
  return (
    <div className={s.field}>
      <label htmlFor="guest-name">Type your name</label>
      <input
        id="guest-name"
        className={s.input}
        value={props.name}
        maxLength={60}
        aria-invalid={!!props.error}
        aria-describedby={props.error ? "guest-name-error" : undefined}
        onChange={(e) => {
          props.setName(e.target.value);
          props.setError(null);
        }}
        {...kioskInput(props.kiosk)}
      />
      {props.error && (
        <p id="guest-name-error" className={s.error}>
          {props.error}
        </p>
      )}
    </div>
  );
}

function TypePanel({ session }: { session: Session }) {
  const { ui, act, unsentRef } = session;
  const kiosk = ui.hello?.kiosk ?? true;
  const [picked, setPicked] = useState<GuestIntentId | null>(null);
  const [text, setText] = useState("");
  const [textErr, setTextErr] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const phrase = useMemo(() => GUEST_PHRASES.find((p) => p.id === picked) ?? null, [picked]);

  useEffect(() => {
    unsentRef.current = text.trim().length > 0 || picked !== null;
  }, [text, picked, unsentRef]);

  const sendText = async () => {
    const problem = typedProblem(text);
    if (problem) return setTextErr(problem);
    setBusy(true);
    const clean = text.normalize("NFC").trim();
    const r = await act({ type: "guest_typed", text: clean });
    setBusy(false);
    if (!r.ok) return setTextErr(r.message);
    setSent(clean);
    setText("");
  };

  return (
    <div className={s.stack}>
      {ui.settings.guestMode === "text_only" && <p className={s.muted}>Text only: the desk&apos;s words appear as text, with no avatar.</p>}
      {ui.echo && <Echo echo={ui.echo} />}
      {sent && !ui.echo && (
        <div className={s.echo} role="status">
          <p className={s.cardTitle}>Sent to the front desk</p>
          <p className={s.cardText}>The desk received: &ldquo;{sent}&rdquo;</p>
          <p className={s.small}>Shown on the desk screen. Staff choose whether to read it aloud.</p>
        </div>
      )}

      {phrase ? (
        <div className={s.card}>
          <ConfirmCard
            ui={ui}
            item={{ text: phrase.text, needsName: phrase.needsName }}
            signs={null}
            simulated={false}
            testMode={false}
            heading="You picked:"
            onSend={async (how) => {
              const r = await act({ type: "guest_phrase", intentId: phrase.id, voice: how.voice, ...(how.name ? { name: how.name } : {}) });
              if (r.ok) setPicked(null);
              return r;
            }}
            fixOptions={[
              { label: "Pick another", run: () => setPicked(null) },
              { label: "Type it myself", run: () => setPicked(null) },
            ]}
          />
        </div>
      ) : (
        <>
          <h3 className={s.subTitle}>Common requests</h3>
          <div className={s.phrases}>
            {GUEST_PHRASES.map((p) => (
              <button
                key={p.id}
                type="button"
                className={s.phraseButton}
                disabled={busy}
                onClick={() => {
                  setPicked(p.id);
                  setSent(null);
                  setTextErr(null);
                }}
              >
                {p.text}
              </button>
            ))}
          </div>
        </>
      )}

      <div className={s.field}>
        <label htmlFor="guest-text">Or type your own message</label>
        <textarea
          id="guest-text"
          className={s.textarea}
          rows={3}
          value={text}
          maxLength={LIMITS.guestTypedMax + 20}
          aria-invalid={!!textErr}
          aria-describedby={textErr ? "guest-text-help guest-text-error" : "guest-text-help"}
          onChange={(e) => {
            setText(e.target.value);
            setTextErr(null);
          }}
          {...kioskInput(kiosk)}
        />
        <p id="guest-text-help" className={s.small}>
          {[...text].length} of {LIMITS.guestTypedMax} characters. Typed messages are shown to the desk; staff choose whether to read them aloud.
        </p>
        {textErr && (
          <p id="guest-text-error" className={s.error}>
            {textErr}
          </p>
        )}
        <button type="button" className={s.primary} disabled={busy} onClick={() => void sendText()}>
          Send to the desk
        </button>
      </div>
    </div>
  );
}

function InterpreterPanel({ session }: { session: Session }) {
  const { ui, requestInterpreter, act } = session;
  const vri = ui.hello?.vri ?? null;
  const kiosk = ui.hello?.kiosk ?? true;
  return (
    <div className={s.stack}>
      <div className={s.card}>
        <p className={s.cardTitle}>Human interpreter</p>
        <VriDetails vri={vri} kiosk={kiosk} />
        <p className={s.lead} role="status">
          {ui.interpreter === "none" && "The desk has not been asked yet."}
          {ui.interpreter === "sent" && "Request sent."}
          {ui.interpreter === "acked" && "The desk is arranging an interpreter."}
        </p>
        {ui.interpreter === "none" && (
          <button type="button" className={s.primary} onClick={() => void requestInterpreter()}>
            Ask for an interpreter
          </button>
        )}
      </div>
      <p className={s.muted}>While you wait, you can still type.</p>
      <button type="button" className={s.secondary} onClick={() => void act({ type: "guest_choice", choice: "type" })}>
        Type instead
      </button>
    </div>
  );
}

function VriDetails({ vri, kiosk }: { vri: VriInfo | null; kiosk: boolean }) {
  if (!vri || (!vri.label && !vri.contact)) return <p className={s.cardText}>{VRI_UNSET_TEXT}</p>;
  return (
    <div>
      {vri.label && <p className={s.cardText}>{vri.label}</p>}
      {vri.contact && (
        <p className={s.lead}>
          {vri.contact.kind === "videophone" ? "Videophone" : "Text"}: {vri.contact.value}
        </p>
      )}
      {vri.url && !kiosk && (
        <p className={s.lead}>
          <a className={s.link} href={vri.url} rel="noopener noreferrer" target="_blank">
            Open the interpreter link
          </a>{" "}
          A video relay call sends your video to that provider.
        </p>
      )}
    </div>
  );
}

function DisplayOnlyYou({ ui }: { ui: GuestUi }) {
  const p = ui.pending;
  return (
    <div className={s.stack}>
      <h2 id="you-title" className={s.sectionTitle}>
        You
      </h2>
      {ui.settings.guestMode === "sign" && ui.framing && ui.framing !== "OK" && <p className={s.framingAlert}>{FRAMING_GUIDANCE[ui.framing]}</p>}
      {ui.live.length > 0 && !p && <SignRow signs={ui.live.map((l) => l.sign)} simulated={ui.live.some((l) => l.simulated)} />}
      {p && (
        <div className={s.card}>
          {p.signs.length > 0 && <SignRow signs={p.signs} simulated={p.simulated} />}
          <p className={s.proposalHeading}>{proposalHeading(p)}</p>
          {p.kind === "pick" && (
            <ol className={s.pointList}>
              {p.candidates.map((c) => (
                <li key={c.candidateId}>{c.text}</li>
              ))}
            </ol>
          )}
          <p className={s.lead}>Point to YES or NO on the card.</p>
        </div>
      )}
      {ui.repeat && !p && <p className={s.cardText}>{REPEAT_TEXT}</p>}
      {ui.echo && !p && <Echo echo={ui.echo} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The guest's own record (BN-5)                                       */
/* ------------------------------------------------------------------ */

function Scrollback({ record, onFinish }: { record: RecordItem[]; onFinish: () => void }) {
  if (record.length === 0) return null;
  return (
    <section className={s.record} aria-labelledby="record-title">
      <h2 id="record-title" className={s.sectionTitle}>
        This conversation
      </h2>
      <p className={s.small}>{GUEST_SCROLLBACK_HINT}</p>
      <ol className={s.recordList}>
        {record.map((r) => (
          <li key={r.key} className={s.recordItem} data-who={r.kind}>
            <span className={s.recordMeta}>
              {r.kind === "desk" ? "Desk" : "You"} <time>{hhmm(r.at)}</time>
            </span>
            <span className={s.recordText}>{r.text}</span>
            {r.kind === "you" && (
              <span className={s.recordNote}>{r.delivery === "spoken" ? "read aloud" : r.delivery === "shown" ? "shown as text" : "on the desk screen"}</span>
            )}
            {r.kind === "desk" && r.fromSpeech && <span className={s.recordNote}>from speech recognition</span>}
          </li>
        ))}
      </ol>
      <button type="button" className={s.quiet} onClick={onFinish}>
        End and delete my session
      </button>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* More menu: modes, settings, text size, interpreter, notice, end     */
/* ------------------------------------------------------------------ */

function MoreMenu({ u }: { u: Ui }) {
  const { ui, act, requestInterpreter } = u.session;
  const [open, setOpen] = useState(false);
  const mode = ui.settings.guestMode;
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes the menu and returns focus to its button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        document.getElementById("guest-more-button")?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className={s.more}>
      <button type="button" id="guest-more-button" className={s.moreButton} aria-expanded={open} aria-controls="guest-more" onClick={() => setOpen((v) => !v)}>
        More
      </button>
      {open && (
        <div id="guest-more" ref={panelRef} className={s.morePanel}>
          <p className={s.subTitle} id="more-mode">
            How I talk
          </p>
          <div className={s.buttonRow} role="group" aria-labelledby="more-mode">
            <button type="button" className={s.secondary} aria-pressed={mode === "sign"} disabled={!ui.signingAvailable} onClick={() => void act({ type: "guest_choice", choice: "sign" })}>
              Sign
            </button>
            <button type="button" className={s.secondary} aria-pressed={mode === "type"} onClick={() => void act({ type: "guest_choice", choice: "type" })}>
              Type
            </button>
            <button type="button" className={s.secondary} aria-pressed={mode === "text_only"} onClick={() => void act({ type: "guest_choice", choice: "text_only" })}>
              Text only
            </button>
          </div>
          <button type="button" className={s.secondary} onClick={() => void requestInterpreter()}>
            Ask for a human interpreter
          </button>
          <p className={s.subTitle} id="more-size">
            Text size
          </p>
          <div className={s.buttonRow} role="group" aria-labelledby="more-size">
            {([0, 1, 2] as TextSize[]).map((n) => (
              <button key={n} type="button" className={s.secondary} aria-pressed={u.textSize === n} onClick={() => u.setTextSize(n)}>
                {TEXT_SIZE_WORDS[n]}
              </button>
            ))}
          </div>
          <label className={s.check}>
            <input type="checkbox" checked={ui.settings.speakAloud} onChange={(e) => void act({ type: "prefs", speakAloud: e.target.checked })} />
            <span>
              Read my sentences aloud at the desk. <span className={s.muted}>People nearby will hear it.</span>
            </span>
          </label>
          <label className={s.check}>
            <input type="checkbox" checked={ui.settings.showAvatar} onChange={(e) => void act({ type: "prefs", showAvatar: e.target.checked })} />
            <span>Show the avatar</span>
          </label>
          <AboutScreen emergencyNote={ui.hello?.emergencyNote ?? ""} />
          <button
            type="button"
            className={s.quiet}
            onClick={() => {
              setOpen(false);
              u.askFinish();
            }}
          >
            End and delete my session
          </button>
        </div>
      )}
    </div>
  );
}
