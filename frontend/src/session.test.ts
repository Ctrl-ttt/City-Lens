import { describe, expect, it } from 'vitest';
import { SessionGate } from './session';

describe('SessionGate', () => {
  it('skips frames while busy and increments frame IDs', () => {
    const gate = new SessionGate();
    const first = gate.acquire(0)!;
    expect(gate.acquire(1)).toBeNull();
    gate.finish(first);
    expect(gate.acquire(2)?.frame).toBe(2);
  });
  it('aborts old work on reset and prevents old finally handlers from clearing new work', () => {
    const gate = new SessionGate();
    const old = gate.acquire(0)!;
    gate.reset();
    const next = gate.acquire(1)!;
    expect(old.controller.signal.aborted).toBe(true);
    expect(gate.current(old)).toBe(false);
    gate.finish(old);
    expect(gate.pending).toBe(next);
    expect(next.frame).toBe(1);
  });
  it('rejects expired results and stops after three consecutive failures', () => {
    const gate = new SessionGate();
    const ticket = gate.acquire(100)!;
    expect(gate.fresh(ticket, 6100, 6000)).toBe(true);
    expect(gate.fresh(ticket, 6101, 6000)).toBe(false);
    expect([gate.failed(), gate.failed(), gate.failed()]).toEqual([false, false, true]);
    gate.succeeded();
    expect(gate.failed()).toBe(false);
  });
});
