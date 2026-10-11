"use client";
// P4 (builder B): the guest screen (docs/app-plan.md sections 4.3 to 4.6).
//
// Rules this file keeps (SES-11, GST-9, SPK-6, A11Y-3, A11Y-5):
// - no camera, microphone, storage or service-worker code; every guest string is rendered as text;
// - the guest never sees a score, a percentage, "sure" or "unclear"; misses name the camera;
// - "Get staff now" has its own full-width row on every screen; Send, Fix and Help sit low;
// - one polite and one assertive live region; a new proposal takes focus only when the guest is
//   not typing;
// - display-only Mode 0 (hello.displayOnly) renders no tappable control at all.
import { useEffect, useMemo, useRef, useState } from "react";
import { KeyTag, SimulatedBadge, TrafficLight } from "@/components/app/KeyTag";
import { GUEST_PHRASES, nameProblem, typedProblem } from "@/components/app/displayVocab";
import {
  END_REASON_GUEST,
  END_SCREEN_PENDING_NOTE,
  END_SCREEN_STORAGE_NOTE,
  FRAMING_GUIDANCE,
  GUEST_NOTICE,
  GUEST_NOTICE_EXTRA,
  GUEST_REPLY_TEXT,
  HELP_LABEL,
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
import { useGuestSession, type ActionOutcome, type GuestUi } from "./useGuestSession";

type Session = ReturnType<typeof useGuestSession>;

const isTyping = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
};

/** Kiosk inputs (every team-owned device): no autocomplete, autocorrect, capitalisation or spellcheck (AS-8). */
const kioskInput = (kiosk: boolean) =>
  kiosk ? ({ autoComplete: "off", autoCorrect: "off", autoCapitalize: "off", spellCheck: false } as const) : {};

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

  return (
    <main className={s.root} data-display-only={displayOnly || undefined}>
      <LiveRegions ui={ui} />
      <GuestBody session={session} />
      <HelpRow session={session} />
    </main>
  );
}

function GuestBody({ session }: { session: Session }) {
  const { ui } = session;
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
      <Header session={session} />
      {ui.warning && <TimeWarning warning={ui.warning} />}
      {ui.notice && <Notice text={ui.notice.text} at={ui.notice.at} />}
      {ui.settings.guestMode === "choosing" ? (
        displayOnly ? <DisplayOnlyChoices /> : <FirstScreen session={session} />
      ) : (
        <Conversation session={session} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Frame: header, live regions, Help row, small messages               */
/* ------------------------------------------------------------------ */

function Header({ session }: { session: Session }) {
  const { ui } = session;
  const displayOnly = ui.hello?.displayOnly ?? false;
  return (
    <header className={s.header}>
      <p className={s.brand}>SignBridge front desk</p>
      {ui.pairedWith && <p className={s.muted}>Paired with {ui.pairedWith}</p>}
      {!displayOnly && ui.settings.guestMode !== "choosing" && <MoreMenu session={session} />}
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
    if (lastLive) setPolite(`Camera read ${lastLive.sign.label}, ${lastLive.sign.light === "green" ? "clear" : lastLive.sign.light === "amber" ? "not certain" : "missed"}`);
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
    if (ui.warning) setAssertive(ui.warning.kind === "idle" ? "This conversation will end soon unless the desk keeps it open." : "This conversation will reach its time limit soon.");
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
    <footer className={s.helpRow}>
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
      This conversation will end in {when} unless the desk keeps it open.
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

/* ------------------------------------------------------------------ */
/* First screen (plan 4.4)                                             */
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
          <span className={s.choiceTitle}>Sign</span>
          <span className={s.choiceText}>
            {ui.signingAvailable ? SIGN_CARD_TEXT : "Signing is not available right now. Please type or ask for an interpreter."}
          </span>
        </button>
        <button type="button" className={s.choice} onClick={() => void choose("type")}>
          <span className={s.choiceTitle}>Type</span>
          <span className={s.choiceText}>Type a message, or tap one of 20 common requests.</span>
        </button>
        <button type="button" className={s.choice} onClick={() => void choose("interpreter")}>
          <span className={s.choiceTitle}>Ask for a human interpreter</span>
          <span className={s.choiceText}>The desk arranges a sign language interpreter. This may take time.</span>
        </button>
        <button type="button" className={s.choice} onClick={() => void choose("text_only")}>
          <span className={s.choiceTitle}>Text only</span>
          <span className={s.choiceText}>Read the desk&apos;s words as text, with no avatar.</span>
        </button>
      </div>
      {error && <p className={s.error}>{error}</p>}
      <label className={s.check}>
        <input type="checkbox" checked={speakAloud} onChange={(e) => void act({ type: "prefs", speakAloud: e.target.checked })} />
        <span>
          Read my sentences aloud at the desk. <span className={s.muted}>People nearby will hear it.</span>
        </span>
      </label>
      <AboutScreen emergencyNote={ui.hello?.emergencyNote ?? ""} />
    </div>
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

function Conversation({ session }: { session: Session }) {
  const { ui } = session;
  const displayOnly = ui.hello?.displayOnly ?? false;
  return (
    <div className={s.conversation}>
      <DeskSaid session={session} />
      <section className={s.you} aria-label="You">
        {displayOnly ? <DisplayOnlyYou ui={ui} /> : <YouPanel session={session} />}
      </section>
    </div>
  );
}

function DeskSaid({ session }: { session: Session }) {
  const { ui, act, captionsSeen } = session;
  const displayOnly = ui.hello?.displayOnly ?? false;
  const latest = ui.captions[0] ?? null;
  const [playKey, setPlayKey] = useState(0);
  const [replySent, setReplySent] = useState<string | null>(null);
  const showAvatar = ui.settings.showAvatar && ui.settings.guestMode !== "text_only";

  useEffect(() => {
    setPlayKey((k) => k + 1);
    setReplySent(null);
  }, [latest?.cap.id]);

  const reply = async (kind: GuestReplyKind) => {
    const r = await act({ type: "guest_reply", reply: kind, captionId: latest?.cap.id ?? null });
    setReplySent(r.ok ? `Sent to the desk: "${GUEST_REPLY_TEXT[kind]}"` : r.message);
  };

  return (
    <section className={s.deskSaid} aria-label="Front desk said" onPointerDown={captionsSeen} onScroll={captionsSeen} onFocus={captionsSeen}>
      <h2 className={s.sectionTitle}>Front desk said</h2>
      {ui.captions.length === 0 && <p className={s.muted}>The desk&apos;s words will appear here.</p>}
      {ui.captions.map((c, i) => (
        <div key={c.cap.id} className={i === 0 ? s.captionLatest : s.captionOld} data-new={(i === 0 && c.isNew) || undefined}>
          <p className={i === 0 ? s.captionText : s.captionTextOld}>
            {c.cap.text}
            {i === 0 && c.isNew && <span className={s.newMark}>New</span>}
          </p>
          {c.cap.captionSource === "voice" && <p className={s.small}>{SPEECH_CAPTION_NOTE}</p>}
          {i === 0 && !displayOnly && showAvatar && c.cap.gloss.length > 0 && (
            <button type="button" className={s.linkButton} onClick={() => setPlayKey((k) => k + 1)}>
              Show again
            </button>
          )}
        </div>
      ))}
      <AvatarStage caption={latest?.cap ?? null} playKey={playKey} showAvatar={showAvatar} interactive={!displayOnly} />
      {latest && !displayOnly && (
        <div className={s.repairRow} role="group" aria-label="Reply to the desk">
          {(Object.keys(GUEST_REPLY_TEXT) as GuestReplyKind[]).map((k) => (
            <button key={k} type="button" className={s.repairButton} onClick={() => void reply(k)}>
              {GUEST_REPLY_TEXT[k].replace(/\.$/, "")}
            </button>
          ))}
        </div>
      )}
      {replySent && <p className={s.small}>{replySent}</p>}
    </section>
  );
}

function YouPanel({ session }: { session: Session }) {
  const { ui } = session;
  const mode = ui.settings.guestMode;
  return (
    <>
      <h2 className={s.sectionTitle}>You</h2>
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

function sendLabel(ui: GuestUi) {
  return ui.settings.speakAloud && ui.settings.guestMode !== "text_only" ? "Send and read aloud" : "Send as text";
}

function SignRow({ signs, simulated }: { signs: GuestSignView[]; simulated: boolean }) {
  return (
    <div className={s.signRow}>
      {simulated && <SimulatedBadge />}
      {signs.map((sg, i) => (
        <span key={`${sg.seq ?? "x"}-${i}`} className={s.signItem}>
          <KeyTag token={sg.label === "NONE" ? "no sign" : sg.label} missed={sg.light === "red"} />
          <TrafficLight light={sg.light} surface="guest" />
        </span>
      ))}
    </div>
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

  return (
    <div className={s.stack}>
      <p className={s.lead}>
        {isMode0 ? "Signing is on. Face the desk camera, with both hands free." : "Signing is on. Put the phone in the stand so both hands are free."}
      </p>
      <p className={framingNotOk ? s.framingAlert : s.framingOk}>{FRAMING_GUIDANCE[ui.framing ?? "OK"]}</p>
      <WhatCanISign />

      {ui.live.length > 0 && !repeat && !ui.echo && (
        <div>
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
            {repeat.streak >= 3 ? (
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

      <button type="button" className={s.quiet} onClick={() => void act({ type: "stop_signing" })}>
        Stop signing
      </button>
    </div>
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
        ? "Shown as text at the desk."
        : "Shown on the desk screen first. Staff choose when to read it aloud.";
  return (
    <div className={s.card}>
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

function ProposalView({ session, proposal }: { session: Session; proposal: GuestProposal }) {
  const { ui, act, emergency } = session;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fixOpen, setFixOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const first = proposal.candidates[0] ?? null;
  const send = sendLabel(ui);

  useEffect(() => {
    if (!isTyping()) headingRef.current?.focus();
  }, [proposal.proposalId]);

  const run = async (p: Promise<ActionOutcome>) => {
    setBusy(true);
    setError(null);
    const r = await p;
    setBusy(false);
    if (!r.ok) {
      if (r.field === "name") setNameErr(r.message);
      else setError(r.message);
    }
  };

  const confirm = (c: Candidate) => {
    if (c.needsName) {
      const problem = nameProblem(name);
      if (problem) return setNameErr(problem);
      return run(act({ type: "guest_confirm", proposalId: proposal.proposalId, candidateId: c.candidateId, name: name.normalize("NFC").trim() }));
    }
    return run(act({ type: "guest_confirm", proposalId: proposal.proposalId, candidateId: c.candidateId }));
  };
  const fix = (action: "sign_again" | "type" | "interpreter" | "not_this") =>
    run(act({ type: "guest_fix", proposalId: proposal.proposalId, action }));

  const testMode = proposal.testMode;

  return (
    <div className={s.card} data-kind={proposal.kind}>
      {proposal.signs.length > 0 && <SignRow signs={proposal.signs} simulated={proposal.simulated} />}
      {testMode && <p className={s.framingAlert}>Test mode: these signs were invented by a test program and will not be spoken.</p>}
      <h3 ref={headingRef} tabIndex={-1} className={s.proposalHeading}>
        {proposalHeading(proposal)}
      </h3>

      {first?.needsName && proposal.kind !== "pick" && proposal.kind !== "unmatched" && (
        <NameField name={name} setName={setName} error={nameErr} setError={setNameErr} kiosk={ui.hello?.kiosk ?? true} />
      )}

      {proposal.kind === "proposal" && first && (
        <div className={s.buttonRow}>
          <button type="button" className={s.primary} disabled={busy || testMode} onClick={() => void confirm(first)}>
            {first.needsName ? "Send" : send}
          </button>
          <button type="button" className={s.secondary} disabled={busy} onClick={() => setFixOpen((v) => !v)} aria-expanded={fixOpen}>
            Fix
          </button>
        </div>
      )}

      {proposal.kind === "did_you_mean" && first && (
        <div className={s.buttonRow}>
          <button type="button" className={s.primary} disabled={busy || testMode} onClick={() => void confirm(first)}>
            Yes
          </button>
          <button type="button" className={s.secondary} disabled={busy} onClick={() => void fix("sign_again")}>
            No, sign again
          </button>
          <button type="button" className={s.quiet} disabled={busy} onClick={() => void fix("type")}>
            Type instead
          </button>
        </div>
      )}

      {proposal.kind === "did_you_mean_help" && (
        <div className={s.buttonRow}>
          <button
            type="button"
            className={s.primary}
            disabled={busy}
            onClick={() => {
              // HELP never alerts without this tap; the alert itself is the emergency action (never refused).
              void emergency();
              if (first && !testMode) void confirm(first);
              else void fix("not_this");
            }}
          >
            Yes, get staff
          </button>
          <button type="button" className={s.secondary} disabled={busy} onClick={() => void fix("not_this")}>
            No
          </button>
        </div>
      )}

      {(proposal.kind === "pick" || proposal.kind === "unmatched") && (
        <div className={s.stack}>
          {proposal.kind === "unmatched" && proposal.candidates.length > 0 && <p className={s.small}>Nearest requests we know:</p>}
          {proposal.candidates.map((c) => (
            <button key={c.candidateId} type="button" className={s.sentenceButton} disabled={busy || testMode} onClick={() => void confirm(c)}>
              {c.text}
            </button>
          ))}
          {proposal.candidates.some((c) => c.needsName) && (
            <NameField name={name} setName={setName} error={nameErr} setError={setNameErr} kiosk={ui.hello?.kiosk ?? true} />
          )}
          <p className={s.small}>None of these:</p>
          <div className={s.buttonRow}>
            <button type="button" className={s.secondary} disabled={busy} onClick={() => void fix("type")}>
              Type
            </button>
            <button type="button" className={s.secondary} disabled={busy} onClick={() => void fix("sign_again")}>
              Sign again
            </button>
            <button type="button" className={s.secondary} disabled={busy} onClick={() => void fix("interpreter")}>
              Interpreter
            </button>
          </div>
        </div>
      )}

      {fixOpen && (
        <div className={s.buttonRow} role="group" aria-label="Fix">
          <button type="button" className={s.secondary} onClick={() => void fix("sign_again")}>
            Sign again
          </button>
          <button type="button" className={s.secondary} onClick={() => void fix("type")}>
            Type instead
          </button>
          <button type="button" className={s.secondary} onClick={() => void fix("interpreter")}>
            Ask for an interpreter
          </button>
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
  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [textErr, setTextErr] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const phrase = useMemo(() => GUEST_PHRASES.find((p) => p.id === picked) ?? null, [picked]);
  const send = sendLabel(ui);

  useEffect(() => {
    unsentRef.current = text.trim().length > 0 || picked !== null;
  }, [text, picked, unsentRef]);

  const sendPhrase = async () => {
    if (!phrase) return;
    let typedName: string | undefined;
    if (phrase.needsName) {
      const problem = nameProblem(name);
      if (problem) return setNameErr(problem);
      typedName = name.normalize("NFC").trim();
    }
    setBusy(true);
    const r = await act({ type: "guest_phrase", intentId: phrase.id, ...(typedName ? { name: typedName } : {}) });
    setBusy(false);
    if (!r.ok) return r.field === "name" ? setNameErr(r.message) : setTextErr(r.message);
    setPicked(null);
    setName("");
  };

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
        <div className={s.card}>
          <p className={s.cardTitle}>Sent to the front desk</p>
          <p className={s.cardText}>The desk received: &ldquo;{sent}&rdquo;</p>
          <p className={s.small}>Shown on the desk screen. Staff choose whether to read it aloud.</p>
        </div>
      )}

      {phrase ? (
        <div className={s.card}>
          <p className={s.small}>You picked:</p>
          <h3 className={s.proposalHeading}>&ldquo;{phrase.needsName ? "My name is ..." : phrase.text}&rdquo;</h3>
          {phrase.needsName && <NameField name={name} setName={setName} error={nameErr} setError={setNameErr} kiosk={kiosk} />}
          <div className={s.buttonRow}>
            <button type="button" className={s.primary} disabled={busy} onClick={() => void sendPhrase()}>
              {phrase.needsName ? "Send" : send}
            </button>
            <button type="button" className={s.secondary} disabled={busy} onClick={() => setPicked(null)}>
              Fix
            </button>
          </div>
          {textErr && <p className={s.error}>{textErr}</p>}
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
                onClick={() => {
                  setPicked(p.id);
                  setSent(null);
                  setTextErr(null);
                }}
              >
                {p.needsName ? "My name is ..." : p.text}
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
          aria-invalid={!!textErr && !phrase}
          aria-describedby="guest-text-help"
          onChange={(e) => {
            setText(e.target.value);
            setTextErr(null);
          }}
          {...kioskInput(kiosk)}
        />
        <p id="guest-text-help" className={s.small}>
          {[...text].length} of {LIMITS.guestTypedMax} characters. Typed messages are shown to the desk; staff choose whether to read them aloud.
        </p>
        {textErr && !phrase && <p className={s.error}>{textErr}</p>}
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
        <p className={s.lead}>
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
      <h2 className={s.sectionTitle}>You</h2>
      {ui.settings.guestMode === "sign" && ui.framing && ui.framing !== "OK" && <p className={s.framingAlert}>{FRAMING_GUIDANCE[ui.framing]}</p>}
      {ui.live.length > 0 && !p && <SignRow signs={ui.live.map((l) => l.sign)} simulated={ui.live.some((l) => l.simulated)} />}
      {p && (
        <div className={s.card}>
          {p.signs.length > 0 && <SignRow signs={p.signs} simulated={p.simulated} />}
          <p className={s.proposalHeading}>{proposalHeading(p)}</p>
          {p.kind === "pick" && (
            <ol className={s.pickList}>
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
/* More menu: modes, settings, interpreter, notice, "I'm finished"      */
/* ------------------------------------------------------------------ */

function MoreMenu({ session }: { session: Session }) {
  const { ui, act, requestInterpreter, finish } = session;
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mode = ui.settings.guestMode;

  return (
    <div className={s.more}>
      <button type="button" className={s.moreButton} aria-expanded={open} aria-controls="guest-more" onClick={() => setOpen((v) => !v)}>
        More
      </button>
      {open && (
        <div id="guest-more" className={s.morePanel}>
          <p className={s.subTitle}>How I talk</p>
          <div className={s.buttonRow}>
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
          <label className={s.check}>
            <input type="checkbox" checked={ui.settings.speakAloud} onChange={(e) => void act({ type: "prefs", speakAloud: e.target.checked })} />
            <span>
              Read my sentences aloud at the desk. <span className={s.muted}>People nearby will hear it.</span>
            </span>
          </label>
          <label className={s.check}>
            <input type="checkbox" checked={ui.settings.showAvatar} onChange={(e) => void act({ type: "prefs", showAvatar: e.target.checked })} />
            <span>Show avatar</span>
          </label>
          <AboutScreen emergencyNote={ui.hello?.emergencyNote ?? ""} />
          <button type="button" className={s.quiet} onClick={() => dialogRef.current?.showModal()}>
            I&apos;m finished
          </button>
        </div>
      )}
      <dialog ref={dialogRef} className={s.dialog} aria-labelledby="finish-title">
        <h2 id="finish-title" className={s.dialogTitle}>
          End this conversation?
        </h2>
        <p className={s.lead}>Everything on this screen will be cleared.</p>
        <div className={s.buttonRow}>
          <button
            type="button"
            className={s.primary}
            onClick={() => {
              dialogRef.current?.close();
              void finish();
            }}
          >
            Yes, end it
          </button>
          <button type="button" className={s.secondary} autoFocus onClick={() => dialogRef.current?.close()}>
            Keep talking
          </button>
        </div>
      </dialog>
    </div>
  );
}
