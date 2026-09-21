import { describe, expect, it, vi } from 'vitest';
import { SpeechQueue, type Candidate } from './speech';

function setup() {
  let time = 0;
  let session = 's';
  const completions: (() => void)[] = [];
  const driver = { speak: vi.fn((_text: string, done: () => void) => completions.push(done)), cancel: vi.fn() };
  const queue = new SpeechQueue(driver, () => session, () => time);
  const candidate = (key: string, priority: Candidate['priority'] = 'low'): Candidate => ({ key, text: key, priority, session, capturedAt: time, maxAge: 6000 });
  return { queue, driver, completions, candidate, tick: (n: number) => { time = n; }, session: (s: string) => { session = s; } };
}

describe('SpeechQueue', () => {
  it('suppresses repeats for 8 seconds, but permits manual replay', () => {
    const t = setup();
    t.queue.offer(t.candidate('bike')); t.completions[0]();
    t.tick(7999); t.queue.offer(t.candidate('bike'));
    expect(t.driver.speak).toHaveBeenCalledTimes(1);
    t.queue.offer({ ...t.candidate('bike'), manual: true }); t.completions[1]();
    expect(t.driver.speak).toHaveBeenCalledTimes(2);
    t.tick(15999); t.queue.offer(t.candidate('bike'));
    expect(t.driver.speak).toHaveBeenCalledTimes(3);
  });
  it('interrupts low priority and ignores completion callbacks from cancelled speech', () => {
    const t = setup();
    t.queue.offer(t.candidate('entrance'));
    t.queue.offer(t.candidate('stairs', 'high'));
    t.completions[0]();
    t.queue.offer(t.candidate('bus'));
    expect(t.driver.speak.mock.calls.map(c => c[0])).toEqual(['entrance', 'stairs']);
    t.completions[1]();
    expect(t.driver.speak.mock.calls.map(c => c[0])).toEqual(['entrance', 'stairs', 'bus']);
  });
  it('keeps only the latest waiting candidate', () => {
    const t = setup();
    for (const key of ['first', 'second', 'third']) t.queue.offer(t.candidate(key));
    t.completions[0]();
    expect(t.driver.speak.mock.calls.map(c => c[0])).toEqual(['first', 'third']);
  });
  it('checks freshness again when waiting speech starts', () => {
    const t = setup();
    t.queue.offer(t.candidate('first')); t.queue.offer(t.candidate('late'));
    t.tick(6001); t.completions[0]();
    expect(t.driver.speak).toHaveBeenCalledTimes(1);
  });
  it('discards speech from old sessions', () => {
    const t = setup(); const old = t.candidate('old');
    t.session('new'); t.queue.offer(old);
    expect(t.driver.speak).not.toHaveBeenCalled();
  });
  it('mute and clear cancel playback and waiting candidates', () => {
    const t = setup();
    t.queue.offer(t.candidate('first')); t.queue.offer(t.candidate('waiting'));
    t.queue.mute(true); t.completions[0](); t.queue.offer(t.candidate('muted'));
    expect(t.driver.speak).toHaveBeenCalledTimes(1);
    t.queue.mute(false); t.queue.clear(); t.queue.offer(t.candidate('first'));
    expect(t.driver.speak).toHaveBeenCalledTimes(2);
  });
});
