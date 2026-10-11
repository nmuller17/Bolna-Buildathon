// SignBridge app (P4, builder A): the server-sent-events bus (docs/app-plan.md 7, 9.4, 10; SES-7, SRV-19).
//
// One bus per process, owned by the store (which lives on globalThis, see runtime.ts). Subscribers
// are plain callbacks, so the bus is testable without HTTP. Rules:
// - every message is one envelope {seq, at, msg}; seq is monotonic for the process and is the SSE id;
// - guest messages are built only from GuestEvent and sent only to that session's guest streams (AS-1);
// - newest wins: opening a stream beyond the per-role limit closes the oldest one;
// - a subscriber is removed when its send fails (the route also removes it on abort and cancel).
import { LIMITS, type BusEnvelope, type GuestEvent, type Role, type StaffEvent } from "./types.ts";

export type Subscriber = {
  id: number;
  role: Role;
  /** Guest streams only: the session the cookie belongs to. */
  sessionId: string | null;
  /** Returns false when the stream is gone (the bus then drops the subscriber). */
  send: (chunk: string) => boolean;
  close: () => void;
  openedAt: number;
};

export type Delivery = { seq: number; delivered: number; bytes: number };

const enc = new TextEncoder();

export function sseFrame<M>(env: BusEnvelope<M>): string {
  return `id: ${env.seq}\ndata: ${JSON.stringify(env)}\n\n`;
}

export class Bus {
  seq = 0;
  nextId = 1;
  subs = new Map<number, Subscriber>();

  /** Adds a subscriber; closes the oldest of the same role (and session) beyond the limit. Returns its id. */
  add(sub: Omit<Subscriber, "id">): number {
    const id = this.nextId++;
    const same = [...this.subs.values()].filter((s) => s.role === sub.role && (sub.role === "staff" || s.sessionId === sub.sessionId));
    const limit = sub.role === "guest" ? LIMITS.maxGuestStreams : LIMITS.maxStaffStreams;
    same.sort((a, b) => a.id - b.id);
    while (same.length >= limit) {
      const old = same.shift();
      if (old) this.drop(old.id);
    }
    this.subs.set(id, { ...sub, id });
    return id;
  }

  /** Removes a subscriber and closes its stream. Safe to call twice. */
  drop(id: number): void {
    const s = this.subs.get(id);
    if (!s) return;
    this.subs.delete(id);
    try {
      s.close();
    } catch {
      // already closed
    }
  }

  private nextEnvelope<M>(msg: M, at: number): BusEnvelope<M> {
    return { seq: ++this.seq, at, msg };
  }

  private deliver(targets: Subscriber[], frame: string): { delivered: number; bytes: number } {
    let delivered = 0;
    for (const s of targets) {
      let ok = false;
      try {
        ok = s.send(frame);
      } catch {
        ok = false;
      }
      if (ok) delivered++;
      else this.drop(s.id);
    }
    return { delivered, bytes: delivered * enc.encode(frame).length };
  }

  toStaff(msg: StaffEvent, at: number): Delivery {
    const env = this.nextEnvelope(msg, at);
    const r = this.deliver([...this.subs.values()].filter((s) => s.role === "staff"), sseFrame(env));
    return { seq: env.seq, ...r };
  }

  /** Sends to every guest stream of the session. The seq is assigned even with no stream open (acks refer to it). */
  toGuest(sessionId: string, msg: GuestEvent, at: number): Delivery {
    const env = this.nextEnvelope(msg, at);
    const r = this.deliver([...this.subs.values()].filter((s) => s.role === "guest" && s.sessionId === sessionId), sseFrame(env));
    return { seq: env.seq, ...r };
  }

  /** Sends to one subscriber only (hello and snapshot on connect). */
  toOne(id: number, msg: GuestEvent | StaffEvent, at: number): Delivery {
    const s = this.subs.get(id);
    const env = this.nextEnvelope(msg, at);
    if (!s) return { seq: env.seq, delivered: 0, bytes: 0 };
    return { seq: env.seq, ...this.deliver([s], sseFrame(env)) };
  }

  /** SSE comment ping (": p"), not an envelope. Also how dead streams are found. */
  ping(role: Role): void {
    this.deliver([...this.subs.values()].filter((s) => s.role === role), ": p\n\n");
  }

  count(role: Role, sessionId?: string | null): number {
    let n = 0;
    for (const s of this.subs.values()) if (s.role === role && (sessionId === undefined || s.sessionId === sessionId)) n++;
    return n;
  }

  closeGuests(sessionId: string): void {
    for (const s of [...this.subs.values()]) if (s.role === "guest" && s.sessionId === sessionId) this.drop(s.id);
  }
}
