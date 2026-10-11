// Turn-taking of the single-screen demo: the receptionist talks and the bellhop signs, then the guest answers
// in signs (recorded by recognition/live_key.py), the answer is spoken aloud, then back to the receptionist.
// Pure reducer: the page feeds it events and runs the side effects (POST /turn, speaking) on phase changes.
import { DEMO_SCRIPT, expectedAfter, qaExpected, scriptedExpected, type Expected } from "./voice/expectedAnswers.ts";
import type { StaffIntentId } from "./voice/intents";

export type TurnPhase =
  | "frontDesk" // mic on, the bellhop signs what the receptionist says
  | "requesting" // POST /turn sent, waiting for the recognizer's turn start
  | "guest" // the guest's turn is open: the camera records their signs
  | "speaking"; // the guest's sentence is being spoken aloud

export type TurnState = {
  phase: TurnPhase;
  since: number; // ms, when the phase started
  staffSigned: boolean; // a receptionist sentence was signed since the last guest turn
  idleSince: number | null; // ms, when the bellhop and the mic both became idle (front desk turn)
  lastIntents: StaffIntentId[]; // intents of the last receptionist sentence
  lastText: string; // the receptionist's last sentence (the question, if there was one)
  expected: Expected; // answers sent with the current / last guest turn
  scriptStep: number; // next step of DEMO_SCRIPT (script mode)
  scripted: boolean; // the current guest turn follows the script
  offline: boolean; // the recognizer did not answer the last request
  said: string | null; // last guest sentence
};

export type TurnEvent =
  | { type: "staffSigned"; intents: StaffIntentId[]; text?: string; now: number } // a receptionist turn finished signing
  | { type: "staffBusy"; now: number } // the mic hears someone, a sentence is being transcribed or signed
  | { type: "staffIdle"; now: number } // bellhop queue empty and mic quiet
  | { type: "tick"; now: number; busy?: boolean } // busy: bellhop signing or mic hearing / translating
  | { type: "requested"; expected: Expected; scriptStep: number; scripted: boolean; now: number }
  | { type: "skipTurn"; scriptStep: number; now: number } // script step without a guest answer: stay at the desk
  | { type: "requestFailed"; now: number }
  | { type: "turnStart"; now: number }
  | { type: "utterance"; text: string; now: number }
  | { type: "turnEnd"; empty: boolean; now: number }
  | { type: "spoken"; now: number }
  | { type: "resetScript"; now: number };

export const GUEST_TURN_DELAY_MS = 500; // silence after the bellhop finished before the guest's turn
export const REQUEST_TIMEOUT_MS = 3000; // no turn start from the recognizer: back to the front desk
export const GUEST_TURN_MAX_MS = 30000; // a guest turn that never ends (lost events)
export const SPEAKING_MAX_MS = 20000;

export const initialTurns = (now = 0): TurnState => ({
  phase: "frontDesk",
  since: now,
  staffSigned: false,
  idleSince: null,
  lastIntents: [],
  lastText: "",
  expected: null,
  scriptStep: 0,
  scripted: false,
  offline: false,
  said: null,
});

const to = (s: TurnState, phase: TurnPhase, now: number, extra: Partial<TurnState> = {}): TurnState => ({
  ...s,
  phase,
  since: now,
  idleSince: null,
  ...extra,
});

/** True when the page should POST /turn now (front desk turn over, the bellhop finished signing). */
export const guestTurnDue = (s: TurnState, now: number) =>
  s.phase === "frontDesk" && s.staffSigned && s.idleSince !== null && now - s.idleSince >= GUEST_TURN_DELAY_MS;

/**
 * Expected answers for the guest turn about to start (script mode: the script step, else the question), with the
 * script step to keep afterwards. The result is the payload of the "requested" event.
 */
export function nextExpected(
  s: TurnState,
  scriptMode: boolean,
): { expected: Expected; scriptStep: number; scripted: boolean; skip: boolean } {
  if (scriptMode && s.scriptStep >= DEMO_SCRIPT.length) {
    // Q&A with the jury after the script: simple answers to a question, no guest turn after anything else.
    const expected = qaExpected(s.lastText);
    return { expected, scriptStep: s.scriptStep, scripted: false, skip: expected === null };
  }
  if (scriptMode) {
    const r = scriptedExpected(s.scriptStep, s.lastIntents, s.expected);
    return { expected: r.expected, scriptStep: r.nextStep, scripted: r.scripted, skip: r.skip };
  }
  return { expected: expectedAfter(s.lastIntents, s.expected), scriptStep: s.scriptStep, scripted: false, skip: false };
}

export function turnsReducer(s: TurnState, e: TurnEvent): TurnState {
  switch (e.type) {
    case "staffSigned":
      if (s.phase !== "frontDesk") return s; // heard during the guest's turn: ignored
      return { ...s, staffSigned: true, lastIntents: e.intents, lastText: e.text ?? "", idleSince: null };
    case "staffBusy":
      return s.phase === "frontDesk" ? { ...s, idleSince: null } : s;
    case "staffIdle":
      return s.phase === "frontDesk" && s.idleSince === null ? { ...s, idleSince: e.now } : s;
    case "tick":
      if (s.phase === "frontDesk" && e.busy !== undefined) {
        if (e.busy && s.idleSince !== null) return { ...s, idleSince: null };
        if (!e.busy && s.idleSince === null) return { ...s, idleSince: e.now };
        return s;
      }
      if (s.phase === "requesting" && e.now - s.since > REQUEST_TIMEOUT_MS) return to(s, "frontDesk", e.now, { offline: true, staffSigned: false });
      if (s.phase === "guest" && e.now - s.since > GUEST_TURN_MAX_MS) return to(s, "frontDesk", e.now, { staffSigned: false });
      if (s.phase === "speaking" && e.now - s.since > SPEAKING_MAX_MS) return to(s, "frontDesk", e.now, { staffSigned: false });
      return s;
    case "requested":
      if (s.phase !== "frontDesk") return s;
      return to(s, "requesting", e.now, { expected: e.expected, scriptStep: e.scriptStep, scripted: e.scripted });
    case "skipTurn":
      return s.phase === "frontDesk" ? { ...s, staffSigned: false, idleSince: null, scriptStep: e.scriptStep } : s;
    case "requestFailed":
      return s.phase === "requesting" ? to(s, "frontDesk", e.now, { offline: true, staffSigned: false }) : s;
    case "turnStart":
      return s.phase === "requesting" || s.phase === "frontDesk" ? to(s, "guest", e.now, { offline: false, said: null }) : s;
    case "utterance":
      if (s.phase !== "guest" || !e.text) return s;
      return to(s, "speaking", e.now, { said: e.text });
    case "turnEnd":
      if (s.phase === "guest") return to(s, "frontDesk", e.now, { staffSigned: false }); // empty, or no text
      return s; // speaking: wait for the voice to finish
    case "spoken":
      return s.phase === "speaking" ? to(s, "frontDesk", e.now, { staffSigned: false }) : s;
    case "resetScript":
      return { ...initialTurns(e.now) };
  }
}
