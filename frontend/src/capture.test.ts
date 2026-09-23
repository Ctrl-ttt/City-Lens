import { afterEach, describe, expect, it, vi } from 'vitest';
import { FramePacer, waitForVideoFrame } from './capture';

afterEach(() => vi.useRealTimers());
describe('live capture pacing', () => {
  it('enforces the fast-response ceiling and releases after a slow round', () => {
    const pace = new FramePacer();
    pace.started(0);
    expect(pace.ready(999)).toBe(false);
    expect(pace.ready(1000)).toBe(true);
    pace.started(1000);
    expect(pace.ready(2300)).toBe(true);
    pace.defer(4300, 15000);
    expect(pace.ready(19299)).toBe(false);
    expect(pace.ready(19300)).toBe(true);
    pace.reset();
    expect(pace.ready(0)).toBe(true);
  });
  it.each(['frame', 'timeout', 'abort'] as const)('cleans up a video callback after %s', async reason => {
    vi.useFakeTimers();
    let callback!: () => void;
    const cancel = vi.fn();
    const video = { paused: false, requestVideoFrameCallback: (fn: () => void) => { callback = fn; return 17; }, cancelVideoFrameCallback: cancel } as unknown as HTMLVideoElement;
    const abort = new AbortController();
    const pending = waitForVideoFrame(video, abort.signal);
    if (reason === 'frame') callback();
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(50);
    if (reason === 'abort') abort.abort();
    await pending;
    expect(cancel).toHaveBeenCalledWith(17);
    expect(vi.getTimerCount()).toBe(0);
  });
});
