import type { Event } from './types';
import type { TrackingInput, TrackingOutput, TrackingSnapshot } from './panoramaTracking';

export type PanoramaAnchor = { id: number; capturedAt: number };

export class PanoramaObserver {
  private worker: Worker | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending = new Set<number>();
  private nextId = 0;
  private mediaTime = -1;

  constructor(private onSnapshot: (snapshot: TrackingSnapshot) => void, private onError: () => void) {}

  anchor(source: HTMLCanvasElement, video: HTMLVideoElement, capturedAt: number): PanoramaAnchor | null {
    try {
      if (!this.worker) {
        const worker = new Worker(new URL('./panoramaTracking.worker.ts', import.meta.url), { type: 'module' });
        this.worker = worker;
        worker.onmessage = ({ data }: MessageEvent<TrackingOutput>) => {
          if (this.worker !== worker) return;
          if (data.type === 'ack') this.pending.delete(data.id);
          else this.onSnapshot(data.snapshot);
        };
        worker.onerror = () => { if (this.worker === worker) this.fail(); };
        worker.onmessageerror = () => { if (this.worker === worker) this.fail(); };
        this.timer = setInterval(() => {
          if (document.hidden || video.paused || video.seeking || video.readyState < 2 || video.currentTime === this.mediaTime) return;
          if (Math.abs(video.videoWidth / video.videoHeight - 2) > 0.04) { this.fail(); return; }
          try {
            if (this.capture(video, Date.now()) !== null) this.mediaTime = video.currentTime;
          } catch { this.fail(); }
        }, 150);
      }
      const id = this.capture(source, capturedAt);
      this.mediaTime = video.currentTime;
      return id === null ? null : { id, capturedAt };
    } catch { this.fail(); return null; }
  }

  resolve(anchor: PanoramaAnchor, frameId: number, heading: number, events: Event[]) {
    try {
      this.worker?.postMessage({ type: 'result', anchorId: anchor.id, capturedAt: anchor.capturedAt, frameId, heading, events } satisfies TrackingInput);
    } catch { this.fail(); }
  }

  private capture(source: CanvasImageSource, at: number): number | null {
    // Bound transferred frames as well as worker history when replay is slower than capture.
    if (!this.worker || this.pending.size >= 2) return null;
    const canvas = this.canvas ??= document.createElement('canvas');
    if (canvas.width !== 320) { canvas.width = 320; canvas.height = 160; }
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('canvas unavailable');
    context.drawImage(source, 0, 0, 320, 160);
    const rgba = context.getImageData(0, 0, 320, 160).data;
    const pixels = new Uint8Array(320 * 160);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
    const id = ++this.nextId;
    this.pending.add(id);
    this.worker.postMessage({ type: 'frame', frame: { id, at, width: 320, height: 160, pixels } } satisfies TrackingInput, [pixels.buffer]);
    return id;
  }

  private fail() { this.dispose(); this.onError(); }

  dispose() {
    clearInterval(this.timer); this.timer = undefined;
    this.worker?.terminate(); this.worker = null;
    this.pending.clear(); this.mediaTime = -1;
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
    this.canvas = null;
  }
}
