export type Ticket = { session: string; frame: number; capturedAt: number; controller: AbortController };

/** Transient backend conditions: congestion and rate limits self-heal, so a round is
 *  skipped without clearing the result or counting toward the three-failure pause. */
export const TRANSIENT_HTTP = new Set(['busy', 'rate_limited', 'network_error', 'model_timeout', 'model_unavailable']);

export class HttpError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HttpError'; }
  get transient() { return TRANSIENT_HTTP.has(this.code); }
}
/** One request in flight, generation fencing, and end-to-end freshness. */
export class SessionGate {
  session = crypto.randomUUID();
  frame = 0;
  pending: Ticket | null = null;
  failures = 0;
  reset() {
    this.pending?.controller.abort();
    this.pending = null;
    this.session = crypto.randomUUID();
    this.frame = 0;
    this.failures = 0;
  }
  acquire(now: number): Ticket | null {
    if (this.pending) return null;
    return this.pending = { session: this.session, frame: ++this.frame, capturedAt: now, controller: new AbortController() };
  }
  current(ticket: Ticket) { return ticket.session === this.session; }
  fresh(ticket: Ticket, now: number, maxAge: number) { return this.current(ticket) && now - ticket.capturedAt <= maxAge; }
  finish(ticket: Ticket) { if (this.pending === ticket) this.pending = null; }
  failed() { return ++this.failures >= 3; }
  succeeded() { this.failures = 0; }
}
