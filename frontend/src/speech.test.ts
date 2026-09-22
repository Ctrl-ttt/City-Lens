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
  it('suppresses repeats for 4 seconds, but permits manual replay', () => {
    const t = setup();
    t.queue.offer(t.candidate('bike')); t.completions[0]();
    t.tick(3999); t.queue.offer(t.candidate('bike'));
    expect(t.driver.speak).toHaveBeenCalledTimes(1);
    t.queue.offer({ ...t.candidate('bike'), manual: true }); t.completions[1]();
    expect(t.driver.speak).toHaveBeenCalledTimes(2);
    t.tick(8000); t.queue.offer(t.candidate('bike'));
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
  it('deduplicates normal sign content for exactly 4 seconds without suppressing a different sign', () => {
    const t = setup();
    const sign = (text: string): Candidate => ({ ...t.candidate(`sign:${text}`, 'normal'), text: `标牌文字：${text}` });
    t.queue.offer(sign('中山路 入口')); t.completions[0]();
    t.tick(1000); t.queue.offer(sign('中山路 入口'));
    expect(t.driver.speak).toHaveBeenCalledTimes(1);
    t.tick(2000); t.queue.offer(sign('测试路')); t.completions[1]();
    expect(t.driver.speak.mock.calls.map(c => c[0])).toEqual(['标牌文字：中山路 入口', '标牌文字：测试路']);
    t.tick(3999); t.queue.offer(sign('中山路 入口'));
    expect(t.driver.speak).toHaveBeenCalledTimes(2);
    t.tick(4000); t.queue.offer(sign('中山路 入口'));
    expect(t.driver.speak.mock.calls.map(c => c[0])).toEqual(['标牌文字：中山路 入口', '标牌文字：测试路', '标牌文字：中山路 入口']);
    expect(t.driver.cancel).not.toHaveBeenCalled();
  });
  it('lets a high obstacle interrupt a normal sign without its cancelled callback advancing the queue', () => {
    const t = setup();
    const sign = { ...t.candidate('sign:测试路', 'normal'), text: '标牌文字：测试路' };
    const obstacle = { ...t.candidate('obstacle:stairs:front', 'high'), text: '前方发现台阶' };
    const nextSign = { ...t.candidate('sign:中山路', 'normal'), text: '标牌文字：中山路' };
    t.queue.offer(sign);
    expect(t.driver.cancel).not.toHaveBeenCalled();
    t.queue.offer(obstacle);
    expect(t.driver.cancel).toHaveBeenCalledTimes(1);
    t.queue.offer(nextSign);
    t.completions[0]();
    expect(t.driver.speak.mock.calls.map(c => c[0])).toEqual([sign.text, obstacle.text]);
    t.completions[1]();
    expect(t.driver.speak.mock.calls.map(c => c[0])).toEqual([sign.text, obstacle.text, nextSign.text]);
  });
  it('allows manual reading of the same sign inside the automatic dedup window', () => {
    const t = setup();
    const sign = { ...t.candidate('sign:测试路', 'normal'), text: '标牌文字：测试路' };
    t.queue.offer(sign); t.completions[0]();
    t.tick(1000);
    t.queue.offer({ ...sign, capturedAt: 1000 });
    expect(t.driver.speak).toHaveBeenCalledTimes(1);
    t.queue.offer({ ...sign, capturedAt: 1000, manual: true });
    expect(t.driver.speak.mock.calls.map(c => c[0])).toEqual([sign.text, sign.text]);
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
