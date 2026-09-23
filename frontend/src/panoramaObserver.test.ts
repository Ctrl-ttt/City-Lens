import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanoramaObserver } from './panoramaObserver';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
}

let canvas: HTMLCanvasElement;
let video: HTMLVideoElement;
let observer: PanoramaObserver;
const onSnapshot = vi.fn(), onError = vi.fn();

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); FakeWorker.instances = [];
  canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(320 * 160 * 4).fill(100) }) }) } as unknown as HTMLCanvasElement;
  video = { currentTime: 0, paused: false, seeking: false, readyState: 4, videoWidth: 640, videoHeight: 320 } as HTMLVideoElement;
  vi.stubGlobal('document', { hidden: false, createElement: () => canvas });
  vi.stubGlobal('Worker', FakeWorker);
  observer = new PanoramaObserver(onSnapshot, onError);
});
afterEach(() => { observer.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('opt-in panorama capture lifecycle', () => {
  it('does not create a worker or capture until an exact request anchor is supplied', () => {
    vi.advanceTimersByTime(3000);
    expect(FakeWorker.instances).toHaveLength(0);
    const anchor = observer.anchor(canvas, video, 1234)!;
    const message = FakeWorker.instances[0].postMessage.mock.calls[0][0];
    expect(anchor).toEqual({ id: 1, capturedAt: 1234 });
    expect(message.frame).toMatchObject({ id: 1, at: 1234, width: 320, height: 160 });
    expect(message.frame.pixels.length).toBe(51200);
    expect(message.frame.pixels[0]).toBe(100);
    expect(FakeWorker.instances[0].postMessage.mock.calls[0][1]).toHaveLength(1);
  });

  it('bounds in-flight frame buffers and resumes only after an acknowledgement', () => {
    observer.anchor(canvas, video, 0);
    video.currentTime = .15; vi.advanceTimersByTime(150);
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    video.currentTime = .3; vi.advanceTimersByTime(150);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect(observer.anchor(canvas, video, 300)).toBeNull();
    worker.onmessage!({ data: { type: 'ack', id: 1 } });
    video.currentTime = .45; vi.advanceTimersByTime(150);
    expect(worker.postMessage).toHaveBeenCalledTimes(3);
  });

  it('skips paused, hidden, seeking and repeated video frames', () => {
    observer.anchor(canvas, video, 0);
    const worker = FakeWorker.instances[0];
    worker.onmessage!({ data: { type: 'ack', id: 1 } });
    vi.advanceTimersByTime(150);
    Object.assign(video, { currentTime: .2, paused: true }); vi.advanceTimersByTime(150);
    Object.assign(video, { paused: false, seeking: true }); vi.advanceTimersByTime(150);
    Object.assign(video, { seeking: false }); Object.assign(document, { hidden: true }); vi.advanceTimersByTime(150);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });

  it('binds the returned result to its exact frame and heading without mutating events', () => {
    const anchor = observer.anchor(canvas, video, 1234)!;
    const events: never[] = [];
    observer.resolve(anchor, 8, -90, events);
    expect(FakeWorker.instances[0].postMessage).toHaveBeenLastCalledWith({ type: 'result', anchorId: 1, capturedAt: 1234, frameId: 8, heading: -90, events: [] });
    expect(events).toEqual([]);
  });

  it('terminates and clears resources, fencing late snapshots and permitting a fresh history', () => {
    observer.anchor(canvas, video, 0);
    const worker = FakeWorker.instances[0];
    observer.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
    worker.onmessage!({ data: { type: 'snapshot', snapshot: {} } });
    expect(onSnapshot).not.toHaveBeenCalled();
    video.currentTime = .2; vi.advanceTimersByTime(300);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(observer.anchor(canvas, video, 500)?.id).toBe(2);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('contains worker and canvas errors within diagnostics', () => {
    observer.anchor(canvas, video, 0);
    FakeWorker.instances[0].onmessageerror!();
    expect(onError).toHaveBeenCalledOnce();
    expect(() => observer.resolve({ id: 1, capturedAt: 0 }, 1, 0, [])).not.toThrow();
    canvas.getContext = () => null;
    expect(observer.anchor(canvas, video, 200)).toBeNull();
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
