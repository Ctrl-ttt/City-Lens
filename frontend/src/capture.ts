/** Wait briefly for fresh decoded pixels; leave no callback behind on stop/timeout. */
export function waitForVideoFrame(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  if (signal.aborted || video.paused || !('requestVideoFrameCallback' in video)) return Promise.resolve();
  return new Promise(resolve => {
    let callback: number | undefined;
    const finish = () => {
      clearTimeout(timer);
      if (callback !== undefined) video.cancelVideoFrameCallback(callback);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, 50);
    signal.addEventListener('abort', finish, { once: true });
    callback = video.requestVideoFrameCallback(finish);
  });
}

/** No frame queue: sample NOW when work finishes, with a 1 s minimum interval. */
export class FramePacer {
  private next = 0;
  ready(now: number) { return now >= this.next; }
  started(now: number) { this.next = now + 1000; }
  defer(now: number, delay: number) { this.next = Math.max(this.next, now + delay); }
  reset() { this.next = 0; }
}
