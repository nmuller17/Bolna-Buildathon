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
//
// docs/features-plan.md (Builder G, 2026-10-11): five-way first screen and header switch (F12, F13),
// picture board (F2), live captions with the backend badge (F3), fact tiles and the take-home card
// (F1, F4), more repair requests and preferences in page memory (F5, F10), a label on every record
// line (F6), number pad (F7), typed "Did you mean...?" (F8), desk alerts (F9), the interpreter consent
// card (F11) and the privacy receipt (F17). Pieces live in ModeChooser, PictureBoard, LiveCaptions,
// FactTiles, NumberPad, DeskAlert, Preferences and common.tsx.
import { useEffect, useMemo, useRef, useState } from "react";
import { GUEST_PHRASES, typedProblem } from "@/components/app/displayVocab";
import { interpreterCard, interpreterCardLines, receiptLines, signLanguageName } from "@/lib/app/guestfeatures";
import { matchTyped } from "@/lib/app/typedmatch";
import { GUEST_INTENTS } from "@/lib/app/vocab";
import {
  END_REASON_GUEST,
  END_SCREEN_PENDING_NOTE,
  END_SCREEN_STORAGE_NOTE,
  FRAMING_GUIDANCE,
  GUEST_REPLY_TEXT,
  GUEST_SCROLLBACK_HINT,
  HELP_LABEL,
  LIGHT_WORDS_GUEST,
  LIMITS,
  REPEAT_TEXT,
  SPEECH_CAPTION_NOTE,
  VRI_UNSET_TEXT,
  CAPTION_BACKEND_LABEL,
  FACT_LABEL,
  type Candidate,
  type GuestIntentId,
  type GuestPrefs,
  type GuestProposal,
  type GuestReplyKind,
  type NumberAbout,
  type VriInfo,
} from "@/lib/app/types";
import { KeyTag } from "@/components/app/KeyTag";
import AvatarStage from "./AvatarStage";
import { ConfirmCard, SignRow, canSpeak, hhmm, isTyping, kioskInput, useNow, type SendHow, type Session } from "./common";
import DeskAlert from "./DeskAlert";
import FactTiles from "./FactTiles";
import s from "./guest.module.css";
import LiveCaptions from "./LiveCaptions";
import { AboutScreen, DisplayOnlyChoices, FirstScreen, ModeSwitch } from "./ModeChooser";
import NumberPad from "./NumberPad";
import PictureBoard from "./PictureBoard";
import Preferences, { DEFAULT_PREFS } from "./Preferences";
import { useGuestSession, type GuestUi, type RecordItem } from "./useGuestSession";

/**
 * Order of the repair replies under the latest caption (plan C2-11, BN-3, features-plan F5). "Say it
 * another way" and "Write the number" are F5 additions.
 */
const REPLY_ORDER: GuestReplyKind[] = ["please_repeat", "slower", "please_type", "say_another_way", "write_number", "show_on_paper", "dont_understand", "wait_please"];

const INTERPRETER_SENT = "Interpreter request sent to the desk.";
const INTERPRETER_ACKED = "The desk is arranging an interpreter.";

/* ------------------------------------------------------------------ */

export default function GuestApp() {
  const session = useGuestSession();
  const { ui, hidden } = session;
  const displayOnly = ui.hello?.displayOnly ?? false;
  // F10: preferences in React state only (AS-3); a new page starts with the defaults.
  const [prefs, setPrefs] = useState<GuestPrefs>(DEFAULT_PREFS);
  const finishRef = useRef<HTMLDialogElement>(null);
  // Preferences are erased with the conversation, like everything else on this screen.
  useEffect(() => {
    if (ui.conn === "ended") setPrefs(DEFAULT_PREFS);
  }, [ui.conn]);

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

  const ui2: Ui = { session, prefs, setPrefs, askFinish: () => finishRef.current?.showModal() };
  const alert = ui.alerts[0] ?? null;

  return (
    <main className={s.root} data-display-only={displayOnly || undefined} data-text-size={prefs.textSize} data-avatar-size={prefs.avatarSize}>
      <LiveRegions ui={ui} />
      {alert && ui.conn !== "ended" && (
        <DeskAlert key={alert.id} alert={alert} flash={prefs.alertFlash} vibrate={prefs.alertVibrate} interactive={!displayOnly} onOk={session.ackAlert} />
      )}
      <GuestBody u={ui2} />
      <HelpRow session={session} />
      {!displayOnly && <FinishDialog dialogRef={finishRef} onFinish={() => void session.finish()} onHelp={() => void session.emergency()} />}
    </main>
  );
}

type Ui = { session: Session; prefs: GuestPrefs; setPrefs: (p: GuestPrefs) => void; askFinish: () => void };

function GuestBody({ u }: { u: Ui }) {
  const { ui } = u.session;
  const displayOnly = ui.hello?.displayOnly ?? false;

  if (ui.conn === "ended" && ui.end) return <EndScreen ui={ui} />;
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
      <TimeWarning warnings={ui.warnings} />
      {ui.notice && <Notice text={ui.notice.text} at={ui.notice.at} />}
      {ui.interpreter !== "none" && ui.settings.guestMode !== "interpreter" && ui.settings.guestMode !== "choosing" && (
        // Asked from the More menu while typing or signing: the guest still sees that the request went
        // out and when the desk answered (the Interpreter panel shows the same states).
        <p className={s.notice}>{ui.interpreter === "acked" ? INTERPRETER_ACKED : INTERPRETER_SENT}</p>
      )}
      {ui.settings.guestMode === "choosing" ? (
        displayOnly ? (
          <DisplayOnlyChoices />
        ) : (
          <FirstScreen session={u.session} language={u.prefs.signLanguage} setLanguage={(l) => u.setPrefs({ ...u.prefs, signLanguage: l })} />
        )
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
      {!displayOnly && ui.settings.guestMode !== "choosing" && <ModeSwitch session={u.session} />}
      {ui.link === "down" && (
        // Robustness: a dropped or frozen connection is shown, never hidden behind an old caption.
        <p className={s.linkDown} role="status">
          <span className={s.linkDot} aria-hidden="true" />
          Reconnecting to the front desk… This screen may be out of date. If you need help now, wave to the desk.
        </p>
      )}
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
    if (!ui.capture) return;
    if (ui.capture.phase === "processing") setPolite("Recording stopped. Reading your sign.");
    else
      setPolite(
        `Get ready. Recording starts in ${ui.capture.countdown ?? 0} seconds and lasts ${ui.capture.duration ?? 2} seconds. Make one sign.`,
      );
  }, [ui.capture]);
  useEffect(() => {
    if (ui.framing && ui.settings.guestMode === "sign") setPolite(FRAMING_GUIDANCE[ui.framing]);
  }, [ui.framing, ui.settings.guestMode]);
  useEffect(() => {
    if (ui.notice) setPolite(ui.notice.text);
  }, [ui.notice]);
  useEffect(() => {
    if (ui.interpreter === "sent") setPolite(INTERPRETER_SENT);
    if (ui.interpreter === "acked") setPolite(INTERPRETER_ACKED);
  }, [ui.interpreter]);
  useEffect(() => {
    if (ui.link === "down") setPolite("Reconnecting to the front desk. This screen may be out of date.");
  }, [ui.link]);
  // F1: a new tile is announced by its label only; the value (a room number, a password) is not read out.
  const factKeys = Object.keys(ui.facts).join(",");
  const prevFacts = useRef("");
  useEffect(() => {
    const before = new Set(prevFacts.current ? prevFacts.current.split(",") : []);
    prevFacts.current = factKeys;
    const added = factKeys ? factKeys.split(",").filter((k) => !before.has(k)) : [];
    if (added.length) setPolite(`New on your screen: ${added.map((k) => FACT_LABEL[k as keyof typeof FACT_LABEL]).join(", ")}.`);
  }, [factKeys]);
  useEffect(() => {
    if (ui.captionBackend) setPolite(`Live captions: ${CAPTION_BACKEND_LABEL[ui.captionBackend]}.`);
  }, [ui.captionBackend]);
  useEffect(() => {
    if (ui.help.state === "sent") setAssertive("Staff has been alerted.");
    if (ui.help.state === "acked") setAssertive("Staff is coming.");
    if (ui.help.state === "failed") setAssertive("This screen could not reach the desk. Wave or knock at the desk.");
  }, [ui.help.state]);
  useEffect(() => {
    if (ui.warnings.idle || ui.warnings.cap) setAssertive("This session will end soon unless the desk keeps it open.");
  }, [ui.warnings.idle, ui.warnings.cap]);
  useEffect(() => {
    if (!ui.end) return;
    // The wipe also clears the polite region: it may still hold the guest's last typed or signed
    // sentence ("Sent to the front desk: ..."), which must not outlive the conversation (BN-4, SES-9).
    setPolite("");
    setAssertive(`This conversation has ended. ${END_REASON_GUEST[ui.end.reason]}`);
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
  // After the session ends the alert has nowhere to go (the cookie is gone, the server answers 401), so the
  // end screen says what does work instead of offering a button that cannot reach staff (UX review 3).
  if (displayOnly || ui.conn === "ended" || ui.conn === "lost" || ui.conn === "no_session" || ui.conn === "link_used") {
    return (
      <footer className={s.helpRow}>
        <p className={s.waveText}>{ui.conn === "ended" ? "Need staff? Wave or knock at the desk." : "Need staff? Wave to the desk."}</p>
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

/** Shows the warning that ends first, with its own reason (idle and cap are separate slots). */
function TimeWarning({ warnings }: { warnings: GuestUi["warnings"] }) {
  const now = useNow();
  const due = (["idle", "cap"] as const)
    .flatMap((kind) => (warnings[kind] ? [{ kind, until: warnings[kind]!.until }] : []))
    .filter((w) => w.until - now >= 500)
    .sort((a, b) => a.until - b.until)[0];
  if (!due) return null;
  const left = Math.max(1, Math.round((due.until - now) / 1000));
  const when = left >= 90 ? `${Math.round(left / 60)} minutes` : `${left} seconds`;
  return (
    <p className={s.timeWarning}>
      This session will end soon: in {when}, unless the desk keeps it open.{" "}
      <span className={s.timeWarningSub}>{due.kind === "cap" ? "It has reached the time limit for one conversation." : "Nobody at the desk has used it for a while."}</span>
    </p>
  );
}

function EndScreen({ ui }: { ui: GuestUi }) {
  const end = ui.end!;
  // F17: the desk's receipt from real counters when it sent one; otherwise what this screen itself knows.
  const lines = end.receipt
    ? receiptLines(end.receipt, hhmm)
    : [
        ...(ui.backendsSeen.filter((b) => b !== "typed").length
          ? [`Live captions: ${ui.backendsSeen.filter((b) => b !== "typed").map((b) => CAPTION_BACKEND_LABEL[b]).join("; ")}.`]
          : []),
        `This screen erased the conversation at ${hhmm(end.at)}.`,
      ];
  return (
    <div className={s.center}>
      <h1 className={s.title}>This conversation has ended.</h1>
      <p className={s.lead}>{END_REASON_GUEST[end.reason]}</p>
      {end.pendingLost && <p className={s.lead}>{END_SCREEN_PENDING_NOTE}</p>}
      <section className={s.receipt} aria-labelledby="receipt-title">
        <h2 id="receipt-title" className={s.receiptTitle}>
          What this conversation used
        </h2>
        <ul className={s.receiptList}>
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>
      <p className={s.muted}>{END_SCREEN_STORAGE_NOTE}</p>
      <p className={s.lead}>If you need anything else, wave to the front desk.</p>
    </div>
  );
}

function FinishDialog({ dialogRef, onFinish, onHelp }: { dialogRef: React.RefObject<HTMLDialogElement | null>; onFinish: () => void; onHelp: () => void }) {
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
      {/* The modal dialog makes the page behind it inert, so Help must live inside it too (UX review 6). */}
      <button
        type="button"
        className={`${s.helpButton} ${s.dialogHelp}`}
        onClick={() => {
          dialogRef.current?.close();
          onHelp();
        }}
      >
        {HELP_LABEL}
      </button>
    </dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Conversation (plan 4.5)                                             */
/* ------------------------------------------------------------------ */

function Conversation({ u }: { u: Ui }) {
  const { ui } = u.session;
  const displayOnly = ui.hello?.displayOnly ?? false;
  // Key-triggered signing: the Record button is used every few seconds, so it also comes first.
  const keySigning = ui.hello?.signTrigger === "key" && ui.settings.guestMode === "sign" && ui.signingAvailable;
  // A repeat request or camera guidance also needs the guest now; on a phone it would sit below the fold.
  // So does "Signing is not available" while the guest is in sign mode (camera program stopped).
  const needsGuest =
    ui.repeat !== null ||
    (ui.settings.guestMode === "sign" && !ui.signingAvailable) ||
    (ui.settings.guestMode === "sign" && ui.framing !== null && ui.framing !== "OK");
  return (
    // While a sentence waits for the guest, a phone shows it first, within thumb reach (plan 4.5).
    <div className={s.conversation} data-pending={((ui.pending !== null || keySigning || needsGuest) && !displayOnly) || undefined}>
      <DeskSaid session={u.session} />
      <section className={s.you} aria-labelledby="you-title">
        {displayOnly ? <DisplayOnlyYou ui={ui} /> : <YouPanel u={u} />}
      </section>
      <FactTiles facts={ui.facts} interactive={!displayOnly} />
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
      <LiveCaptions captions={ui.liveCaptions} backend={ui.captionBackend} />
      {ui.captions.length === 0 && ui.liveCaptions.length === 0 && <p className={s.muted}>The desk&apos;s words will appear here.</p>}
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

/** "Talk to an interpreter now" comes first after Help, after two missed signs, or when the guest asked for it (F11 E3). */
function interpreterFirst(ui: GuestUi, prefs: GuestPrefs): boolean {
  if (ui.settings.guestMode === "interpreter") return false;
  return prefs.interpreterFirst || ui.help.state !== "none" || (ui.repeat?.streak ?? 0) >= 2 || ui.pending?.kind === "did_you_mean_help";
}

/** A number pad preset from the desk's latest question, e.g. "How many nights?" (F7). */
function numberHint(ui: GuestUi): NumberAbout | null {
  const t = ui.captions[0]?.cap.text ?? "";
  if (/how many nights/i.test(t)) return "nights";
  if (/how many (people|guests|adults)/i.test(t)) return "people";
  return null;
}

function InterpreterNow({ session }: { session: Session }) {
  const { ui, act, requestInterpreter } = session;
  return (
    <div className={s.interpreterNow}>
      <button
        type="button"
        className={s.primary}
        onClick={() => {
          void act({ type: "guest_choice", choice: "interpreter" });
          if (ui.interpreter === "none") void requestInterpreter();
        }}
      >
        Talk to an interpreter now
      </button>
      {ui.interpreter !== "none" && <p className={s.small}>{ui.interpreter === "acked" ? INTERPRETER_ACKED : INTERPRETER_SENT}</p>}
    </div>
  );
}

function YouPanel({ u }: { u: Ui }) {
  const session = u.session;
  const { ui } = session;
  const mode = ui.settings.guestMode;
  const [numbers, setNumbers] = useState(false);
  const hint = numberHint(ui);
  // The desk asked a number question: the pad opens by itself (the guest can still close it).
  useEffect(() => {
    if (hint && (mode === "type" || mode === "tap" || mode === "text_only")) setNumbers(true);
  }, [hint, mode]);
  const canNumber = mode === "type" || mode === "tap" || mode === "text_only";
  return (
    <>
      <h2 id="you-title" className={s.sectionTitle}>
        You
      </h2>
      {!ui.pending && interpreterFirst(ui, u.prefs) && <InterpreterNow session={session} />}
      {ui.pending ? (
        <ProposalView key={ui.pending.proposalId} session={session} proposal={ui.pending} />
      ) : (
        <>
          {mode === "sign" && <SignPanel session={session} />}
          {mode === "tap" && (
            <div className={s.stack}>
              {ui.echo && <Echo echo={ui.echo} />}
              <PictureBoard session={session} />
            </div>
          )}
          {(mode === "type" || mode === "text_only") && <TypePanel session={session} />}
          {mode === "interpreter" && <InterpreterPanel u={u} />}
          {canNumber && (
            <div className={s.numberBlock}>
              <button type="button" className={s.secondary} aria-expanded={numbers} aria-controls="number-pad" onClick={() => setNumbers((v) => !v)}>
                {numbers ? "Close the number pad" : "Type a number"}
              </button>
              {numbers && (
                <div id="number-pad">
                  <NumberPad session={session} suggestAbout={hint} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

function SignPanel({ session }: { session: Session }) {
  const { ui, act, dismissRepeat } = session;
  const isMode0 = ui.hello?.mode === "mode0";
  const repeatActions = useRef<HTMLDivElement>(null);
  // A repeat request needs the guest now: keep its buttons above the sticky Help row (UX review 2).
  useEffect(() => {
    if (!ui.repeat) return;
    // The whole card when it fits, and in any case its buttons.
    repeatActions.current?.parentElement?.scrollIntoView({ block: "nearest" });
    repeatActions.current?.scrollIntoView({ block: "nearest" });
  }, [ui.repeat]);

  if (!ui.signingAvailable) {
    return (
      <div className={s.stack}>
        <p className={s.lead}>Signing is not available right now. Please type, tap pictures or ask for an interpreter.</p>
        <div className={s.buttonRow}>
          <button type="button" className={s.primary} onClick={() => void act({ type: "guest_choice", choice: "type" })}>
            Type instead
          </button>
          <button type="button" className={s.secondary} onClick={() => void act({ type: "guest_choice", choice: "tap" })}>
            Tap pictures
          </button>
        </div>
      </div>
    );
  }

  const repeat = ui.repeat;
  const framingNotOk = ui.framing && ui.framing !== "OK";
  const keyTrigger = ui.hello?.signTrigger === "key";
  // BT-26: after two framing misses in a row, or three misses of any kind, typing comes first.
  const typeFirst = repeat ? repeat.streak >= 3 || (repeat.streak >= 2 && repeat.reason === "framing") : false;

  return (
    <div className={s.stack}>
      <p className={s.lead}>
        {keyTrigger
          ? "Signing is on. Tap Record a sign, wait for the countdown, then make one sign. Repeat for each word."
          : isMode0
            ? "Signing is on. Face the desk camera, with both hands free."
            : "Signing is on. Put the phone in the stand so both hands are free."}
      </p>
      {(!keyTrigger || ui.framing !== null) && (
        <p className={framingNotOk ? s.framingAlert : s.framingOk}>
          <FramingIcon ok={!framingNotOk} />
          {FRAMING_GUIDANCE[ui.framing ?? "OK"]}
        </p>
      )}

      {keyTrigger && !repeat && <KeyCapture session={session} onRecord={dismissRepeat} />}

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
          <div className={s.buttonRow} ref={repeatActions}>
            {typeFirst ? (
              <>
                <button type="button" className={s.primary} onClick={() => void act({ type: "guest_choice", choice: "type" })}>
                  Type instead
                </button>
                <button type="button" className={s.secondary} onClick={dismissRepeat}>
                  Sign again
                </button>
              </>
            ) : (
              <>
                <button type="button" className={s.primary} onClick={dismissRepeat}>
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

      {repeat && repeat.streak >= 2 && (
        // Two missed signs in a row: the pictures are already here, no extra tap (features-plan F2 E4).
        <div className={s.otherWays}>
          <h3 className={s.subTitle}>Or tap a picture instead</h3>
          <PictureBoard session={session} compact />
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

/** Seconds left in the current capture phase, from this screen's clock. */
type CaptureView = { step: "ready" | "rec" | "reading"; left: number; total: number };

function captureView(c: GuestUi["capture"], now: number): CaptureView | null {
  if (!c) return null;
  if (c.phase === "processing") return { step: "reading", left: 0, total: 1 };
  const t = (now - c.at) / 1000;
  const cd = c.countdown ?? 0;
  const dur = c.duration ?? 2;
  if (t < cd) return { step: "ready", left: cd - t, total: cd };
  if (t < cd + dur) return { step: "rec", left: cd + dur - t, total: dur };
  return { step: "reading", left: 0, total: 1 };
}

const CAPTURE_WORDS: Record<CaptureView["step"], string> = { ready: "Get ready", rec: "Sign now", reading: "Reading your sign" };

/**
 * Key-triggered signing (live_key.py through the app server, shared contract 2026-10-11): one tap
 * records one sign, recorded exactly like the training takes. The countdown comes from the
 * recognizer's own "capture" events, drawn on this screen's clock. Nothing is sent to the desk until
 * the guest checks the sentence (BN-1).
 */
function KeyCapture({ session, onRecord }: { session: Session; onRecord: () => void }) {
  const { ui, act } = session;
  const [waiting, setWaiting] = useState<null | "record" | "undo" | "end">(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const view = captureView(ui.capture, now);
  const count = ui.liveClosed ? 0 : ui.live.length;

  // Ticks only while a recording is on screen.
  useEffect(() => {
    if (!ui.capture || ui.capture.phase === "processing") return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [ui.capture]);

  // The recording ended with a sign (or a proposal / repeat cleared it): the buttons come back.
  useEffect(() => {
    if (waiting === "record" && ui.capture === null) setWaiting(null);
  }, [ui.capture, waiting]);
  // A recording that never reports back (camera program stopped) frees the buttons after 8 s.
  useEffect(() => {
    if (!waiting) return;
    const id = setTimeout(() => setWaiting(null), 8_000);
    return () => clearTimeout(id);
  }, [waiting]);

  const busy = waiting !== null || (view !== null && view.step !== "reading") || ui.capture?.phase === "processing";

  const send = async (cmd: "record" | "undo" | "end") => {
    setError(null);
    setWaiting(cmd);
    if (cmd === "record") onRecord();
    const r = await act({ type: "sign_control", cmd });
    if (!r.ok) {
      setError(r.message);
      setWaiting(null);
    } else if (cmd !== "record") {
      setWaiting(null);
    }
  };

  const ring = view ? (view.step === "reading" ? 1 : Math.max(0, Math.min(1, view.left / Math.max(view.total, 0.001)))) : 0;

  return (
    <div className={s.capture} data-step={view?.step ?? "idle"}>
      <div className={s.captureDial} style={{ ["--p" as string]: ring.toFixed(3) }} aria-hidden="true">
        <span className={s.captureNumber}>{view ? (view.step === "reading" ? "…" : Math.ceil(view.left)) : count}</span>
      </div>
      <div className={s.captureText}>
        <p className={s.captureWord}>{view ? CAPTURE_WORDS[view.step] : count === 0 ? "Ready for your first sign" : `${count} ${count === 1 ? "sign" : "signs"} so far`}</p>
        <p className={s.small}>
          {view?.step === "ready"
            ? "Raise your hands when the count reaches zero."
            : view?.step === "rec"
              ? "Make one sign now. Hands down when it is done."
              : view?.step === "reading"
                ? "The computer is reading the sign. This takes a moment."
                : count === 0
                  ? "One sign per recording. Hands down between signs."
                  : "Record the next sign, or finish. You check the sentence before anything is sent."}
        </p>
      </div>
      <div className={s.captureButtons}>
        <button type="button" className={s.primary} disabled={busy} onClick={() => void send("record")}>
          {view && view.step !== "reading" ? "Recording…" : count === 0 ? "Record a sign" : "Record the next sign"}
        </button>
        <button type="button" className={s.secondary} disabled={busy || count === 0} onClick={() => void send("end")}>
          Finish sentence
        </button>
        <button type="button" className={s.secondary} disabled={busy || count === 0} onClick={() => void send("undo")}>
          Undo last sign
        </button>
      </div>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
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
/* Confirm before speaking (BN-1): ConfirmCard lives in common.tsx    */
/* ------------------------------------------------------------------ */

function ProposalView({ session, proposal }: { session: Session; proposal: GuestProposal }) {
  const { ui, act, emergency, closeProposal } = session;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<Candidate | null>(proposal.kind === "proposal" ? (proposal.candidates[0] ?? null) : null);
  const [error, setError] = useState<string | null>(null);
  const first = proposal.candidates[0] ?? null;

  useEffect(() => {
    if (isTyping()) return;
    headingRef.current?.focus({ preventScroll: true });
    // The answer buttons, not just the heading, must clear the sticky Help row (landscape phone, UX review 2).
    const actions = cardRef.current?.querySelector<HTMLElement>("[data-actions]");
    cardRef.current?.scrollIntoView({ block: "nearest" });
    actions?.scrollIntoView({ block: "nearest" });
  }, [proposal.proposalId, chosen]);

  // The server has closed this sentence (Fix accepted), or it is no longer waiting (409): the card goes,
  // so the guest is never left on a sentence nothing can act on (UX review 1).
  const fix = async (action: "sign_again" | "type" | "interpreter" | "not_this") => {
    setError(null);
    const r = await act({ type: "guest_fix", proposalId: proposal.proposalId, action });
    if (r.ok) return closeProposal(proposal.proposalId);
    if (r.status === 409) return closeProposal(proposal.proposalId, "That sentence is no longer waiting. Please sign again or type.");
    setError(r.message);
  };
  const confirm = (c: Candidate) => async (how: SendHow) => {
    const r = await act({ type: "guest_confirm", proposalId: proposal.proposalId, candidateId: c.candidateId, voice: how.voice, ...(how.name ? { name: how.name } : {}) });
    if (!r.ok && r.status === 409 && !proposal.testMode) closeProposal(proposal.proposalId, "That sentence is no longer waiting. Please sign again or type.");
    return r;
  };

  const fixOptions = [
    ...(proposal.candidates.length > 1 && chosen ? [{ label: "Choose another", run: () => setChosen(null) }] : []),
    { label: "Type instead", run: () => void fix("type") },
    { label: "Sign again", run: () => void fix("sign_again") },
    { label: "Ask for an interpreter", run: () => void fix("interpreter") },
  ];

  // A sentence is chosen (a confident proposal, or the guest picked one): confirm it (BN-1).
  if (chosen && proposal.kind !== "did_you_mean_help") {
    return (
      <div className={s.card} data-kind={proposal.kind} ref={cardRef}>
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
    <div className={s.card} data-kind={proposal.kind} ref={cardRef}>
      {proposal.signs.length > 0 && <SignRow signs={proposal.signs} simulated={proposal.simulated} />}
      {proposal.testMode && <p className={s.framingAlert}>Test mode: these signs were invented by a test program and will not be spoken.</p>}
      <h3 ref={headingRef} tabIndex={-1} className={s.proposalHeading}>
        {proposalHeading(proposal)}
      </h3>

      {proposal.kind === "did_you_mean" && first && (
        <div className={s.buttonRow} data-actions="">
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
        <div className={s.buttonRow} data-actions="">
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
          <div className={s.buttonRow} data-actions="">
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

function TypePanel({ session }: { session: Session }) {
  const { ui, act, unsentRef, sendingVia } = session;
  const kiosk = ui.hello?.kiosk ?? true;
  const [picked, setPicked] = useState<GuestIntentId | null>(null);
  /** F8: how the picked sentence was reached: tapped in the list, or offered after typing. */
  const [pickedVia, setPickedVia] = useState<"phrase_list" | "typed_match">("phrase_list");
  /** F8: the typed words and the fixed requests they look like, shown before anything is sent. */
  const [suggest, setSuggest] = useState<{ text: string; ids: GuestIntentId[] } | null>(null);
  const suggestRef = useRef<HTMLHeadingElement>(null);
  const [text, setText] = useState("");
  const [textErr, setTextErr] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const phrase = useMemo(() => GUEST_PHRASES.find((p) => p.id === picked) ?? null, [picked]);
  const fieldRef = useRef<HTMLDivElement>(null);
  const echoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    unsentRef.current = text.trim().length > 0 || picked !== null || suggest !== null;
  }, [text, picked, suggest, unsentRef]);

  // UX review 4: on a phone the typing box sat 1.5 screens down, below the avatar and the 20 phrases.
  // The box now comes before the phrases, and switching to Type brings it into view (no focus, so the
  // on-screen keyboard does not jump up by itself).
  useEffect(() => {
    if (ui.settings.guestMode === "type") fieldRef.current?.scrollIntoView({ block: "nearest" });
  }, [ui.settings.guestMode]);
  // After Send, the confirmation is what the guest needs to see, not an empty box.
  useEffect(() => {
    if (sent || ui.echo) echoRef.current?.scrollIntoView({ block: "nearest" });
  }, [sent, ui.echo]);

  useEffect(() => {
    if (suggest) suggestRef.current?.focus({ preventScroll: false });
  }, [suggest]);

  const sendTyped = async (clean: string) => {
    setBusy(true);
    sendingVia("typed");
    const r = await act({ type: "guest_typed", text: clean });
    setBusy(false);
    if (!r.ok) return setTextErr(r.message);
    setSuggest(null);
    setSent(clean);
    setText("");
  };

  // F8: if the words look like one of the fixed requests, offer it first ("Did you mean...?"). The
  // guest's own words are never changed; "Send my words as typed" is always one tap away.
  const sendText = async () => {
    const problem = typedProblem(text);
    if (problem) return setTextErr(problem);
    const clean = text.normalize("NFC").trim();
    const ids = matchTyped(clean).map((m) => m.intentId);
    if (ids.length > 0) {
      setSent(null);
      return setSuggest({ text: clean, ids });
    }
    await sendTyped(clean);
  };

  return (
    <div className={s.stack}>
      {ui.settings.guestMode === "text_only" && <p className={s.muted}>Text only: the desk&apos;s words appear as text, with no avatar.</p>}
      <div ref={echoRef} className={s.echoSlot}>
        {ui.echo && <Echo echo={ui.echo} />}
        {sent && !ui.echo && (
          <div className={s.echo} role="status">
            <p className={s.cardTitle}>Sent to the front desk</p>
            <p className={s.cardText}>The desk received: &ldquo;{sent}&rdquo;</p>
            <p className={s.small}>Shown on the desk screen. Staff choose whether to read it aloud.</p>
          </div>
        )}
      </div>

      <div className={s.field} ref={fieldRef}>
        <label htmlFor="guest-text">Type your message</label>
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

      {phrase ? (
        <div className={s.card}>
          <ConfirmCard
            ui={ui}
            item={{ text: phrase.text, needsName: phrase.needsName }}
            signs={null}
            simulated={false}
            testMode={false}
            heading={pickedVia === "typed_match" ? "You chose this request:" : "You picked:"}
            onSend={async (how: SendHow) => {
              sendingVia(pickedVia);
              const r = await act({ type: "guest_phrase", intentId: phrase.id, via: pickedVia, voice: how.voice, ...(how.name ? { name: how.name } : {}) });
              if (r.ok) {
                setPicked(null);
                if (pickedVia === "typed_match") {
                  setText("");
                  setSuggest(null);
                }
              }
              return r;
            }}
            fixOptions={[
              { label: "Pick another", run: () => setPicked(null) },
              ...(pickedVia === "typed_match" && suggest
                ? [{ label: "Send my words as typed", run: () => void sendTyped(suggest.text).then(() => setPicked(null)) }]
                : [{ label: "Type it myself", run: () => setPicked(null) }]),
            ]}
          />
        </div>
      ) : suggest ? (
        <div className={s.card} data-kind="typed_match">
          <h3 ref={suggestRef} tabIndex={-1} className={s.subTitle}>
            Did you mean:
          </h3>
          <div className={s.pickList} data-actions="">
            {suggest.ids.map((id) => {
              const g = GUEST_INTENTS.find((x) => x.id === id);
              if (!g) return null;
              return (
                <button
                  key={id}
                  type="button"
                  className={s.sentenceButton}
                  onClick={() => {
                    setPickedVia("typed_match");
                    setPicked(id);
                  }}
                >
                  {g.needsName ? "My name is ..." : g.text}
                </button>
              );
            })}
          </div>
          <p className={s.small}>A set request can be read aloud by the desk&apos;s voice straight away. Your own words are shown to the desk first.</p>
          <div className={s.buttonRow}>
            <button type="button" className={s.secondary} disabled={busy} onClick={() => void sendTyped(suggest.text)}>
              Send my words as typed
            </button>
            <button type="button" className={s.quiet} onClick={() => setSuggest(null)}>
              Change my words
            </button>
          </div>
        </div>
      ) : (
        <>
          <h3 className={s.subTitle}>Or tap a common request</h3>
          <div className={s.phrases}>
            {GUEST_PHRASES.map((p) => (
              <button
                key={p.id}
                type="button"
                className={s.phraseButton}
                disabled={busy}
                onClick={() => {
                  setPickedVia("phrase_list");
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
    </div>
  );
}

/**
 * Human interpreter (F11). The request itself goes out with one tap and carries nothing. The card is
 * optional: the guest sees its exact text, ticks what to share, and only then sends it to the desk.
 * The app calls no interpreting provider; staff read or copy the card.
 */
function InterpreterPanel({ u }: { u: Ui }) {
  const { session, prefs } = u;
  const { ui, requestInterpreter, act } = session;
  const vri = ui.hello?.vri ?? null;
  const kiosk = ui.hello?.kiosk ?? true;
  const [shareLanguage, setShareLanguage] = useState(false);
  const [shareTopics, setShareTopics] = useState(false);
  const [cardSent, setCardSent] = useState<string | null>(null);
  const lastFixed = [...ui.record].reverse().find((r) => r.kind === "you" && GUEST_INTENTS.some((g) => !g.needsName && g.text === r.text));
  const card = interpreterCard({ shareLanguage, language: prefs.signLanguage, shareTopics, intents: ui.sentIntents, openRequest: lastFixed?.text ?? null });
  const lines = interpreterCardLines(card);
  const preview = interpreterCardLines(interpreterCard({ shareLanguage: true, language: prefs.signLanguage, shareTopics: true, intents: ui.sentIntents, openRequest: lastFixed?.text ?? null }));

  const sendCard = async () => {
    const r = await requestInterpreter({ language: shareLanguage ? prefs.signLanguage : null, topics: shareTopics });
    setCardSent(r.ok ? "The card was sent to the desk." : r.message);
  };

  return (
    <div className={s.stack}>
      <div className={s.card}>
        <p className={s.cardTitle}>Human interpreter</p>
        <VriDetails vri={vri} kiosk={kiosk} />
        <p className={s.lead} role="status">
          {ui.interpreter === "none" && "The desk has not been asked yet."}
          {ui.interpreter === "sent" && "Request sent."}
          {ui.interpreter === "acked" && INTERPRETER_ACKED}
        </p>
        {ui.interpreter === "none" && (
          <button type="button" className={s.primary} onClick={() => void requestInterpreter()}>
            Ask for an interpreter
          </button>
        )}
      </div>

      <details className={s.about}>
        <summary>Share a short card with the interpreter (optional)</summary>
        <p>The interpreter can start faster if they know a little. Tick what you want to share. Nothing is shared unless you tick it and tap Send.</p>
        <label className={s.check}>
          <input type="checkbox" checked={shareLanguage} onChange={(e) => setShareLanguage(e.target.checked)} />
          <span>My sign language: {signLanguageName(prefs.signLanguage)}</span>
        </label>
        <label className={s.check}>
          <input type="checkbox" checked={shareTopics} onChange={(e) => setShareTopics(e.target.checked)} />
          <span>What we talked about so far (topic words only, never my name or numbers)</span>
        </label>
        <div className={s.consentCard} aria-label="The card exactly as the desk will see it">
          <p className={s.small}>The desk will see exactly this:</p>
          {lines.length ? (
            <ul className={s.consentLines}>
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : (
            <p className={s.cardText}>Nothing ticked. No card will be sent.</p>
          )}
          {lines.length === 0 && preview.length > 0 && <p className={s.small}>If you tick both: {preview.join(" · ")}</p>}
        </div>
        <button type="button" className={s.secondary} disabled={lines.length === 0} onClick={() => void sendCard()}>
          Send this card to the desk
        </button>
        {cardSent && (
          <p className={s.small} role="status">
            {cardSent}
          </p>
        )}
      </details>

      <p className={s.muted}>While you wait, you can still type or tap pictures.</p>
      <div className={s.buttonRow}>
        <button type="button" className={s.secondary} onClick={() => void act({ type: "guest_choice", choice: "type" })}>
          Type instead
        </button>
        <button type="button" className={s.secondary} onClick={() => void act({ type: "guest_choice", choice: "tap" })}>
          Tap pictures
        </button>
      </div>
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
            {r.kind === "desk" && r.retracted ? (
              <span className={s.recordText}>
                <del>{r.text}</del> <span className={s.recordNote}>Removed by the desk</span>
              </span>
            ) : (
              <span className={s.recordText}>{r.text}</span>
            )}
            {/* F6: exactly one machine-or-human label per line, then how it was delivered. */}
            <span className={s.recordNote}>
              <span className={s.lineLabel}>{r.label}</span>
              {r.kind === "you" && r.delivery !== "number" && (r.delivery === "spoken" ? ", read aloud" : r.delivery === "shown" ? ", shown as text" : ", on the desk screen")}
            </span>
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
/* More menu: preferences (F5, F10), notice, end. Modes are in the header (F12). */
/* ------------------------------------------------------------------ */

function MoreMenu({ u }: { u: Ui }) {
  const { ui } = u.session;
  const [open, setOpen] = useState(false);
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
          <Preferences session={u.session} prefs={u.prefs} setPrefs={u.setPrefs} />
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
