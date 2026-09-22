import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureRealtimeFrame, MAX_IMAGE_BASE64, RealtimeClient, realtimeUrl } from './realtime';
import type { RealtimeFrame } from './types';

class MockSocket {
  static OPEN = 1;
  static instances: MockSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
  constructor(public url: string) { MockSocket.instances.push(this); }
  ready() { this.readyState = 1; this.message({ type: 'ready' }); }
  message(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}
const frame: RealtimeFrame = { type: 'frame', session_id: 'session-1', frame_id: 1, mode: 'walk', source: 'camera', image: '/9j/AAAA' };
const result = { type: 'result', session_id: frame.session_id, frame_id: frame.frame_id, status: 'ok', events: [], speech: null, latency_ms: 100 };
const latest = () => MockSocket.instances.at(-1)!;
function setup() {
  const callbacks = { onState: vi.fn(), onReady: vi.fn(), onDisconnect: vi.fn() };
  const client = new RealtimeClient(callbacks);
  client.start();
  return { client, ...callbacks };
}

beforeEach(() => {
  vi.useFakeTimers(); MockSocket.instances = [];
  vi.stubGlobal('WebSocket', MockSocket);
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost:5173' } });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('RealtimeClient', () => {
  it('uses only same-origin ws/wss and never sends before backend ready', () => {
    expect(realtimeUrl({ protocol: 'https:', host: 'city.example:443' })).toBe('wss://city.example:443/api/realtime');
    const { client, onReady } = setup();
    const socket = latest();
    expect(socket.url).toBe('ws://localhost:5173/api/realtime');
    socket.readyState = 1; socket.onopen?.();
    vi.advanceTimersByTime(8000);
    expect(client.isReady).toBe(false);
    expect(client.send(frame, new AbortController().signal)).toBeNull();
    expect(socket.send).not.toHaveBeenCalled();
    socket.ready(); socket.ready();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(client.isReady).toBe(true);
    client.close();
  });

  it('matches both session/frame and drops busy work without a queue', async () => {
    const { client } = setup(); latest().ready();
    const promise = client.send(frame, new AbortController().signal)!;
    const settled = vi.fn(); void promise.then(settled);
    expect(client.send({ ...frame, frame_id: 2 }, new AbortController().signal)).toBeNull();
    latest().message({ ...result, session_id: 'old' });
    latest().message({ ...result, frame_id: 2 });
    await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    latest().message(result);
    await expect(promise).resolves.toMatchObject(result);
    expect(latest().send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(latest().send.mock.calls[0][0])).toEqual(frame);
    latest().bufferedAmount = 1;
    expect(client.send(frame, new AbortController().signal)).toBeNull();
    client.close();
  });

  it('starts a nine-second frame deadline only after ready and reconnects without replaying', async () => {
    const { client, onDisconnect } = setup();
    vi.advanceTimersByTime(8000); latest().ready();
    const first = latest();
    const promise = client.send(frame, new AbortController().signal)!;
    const rejected = expect(promise).rejects.toMatchObject({ code: 'model_timeout' });
    vi.advanceTimersByTime(8999); expect(first.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); await rejected;
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ code: 'model_timeout' }), true);
    vi.advanceTimersByTime(1000); latest().ready();
    expect(latest().send).not.toHaveBeenCalled();
    client.close();
  });

  it.each(['close', 'abort'] as const)('%s rejects pending work and cancels all timers', async action => {
    const { client, onDisconnect } = setup(); latest().ready();
    const abort = new AbortController();
    const promise = client.send(frame, abort.signal)!;
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    if (action === 'close') client.close(); else abort.abort();
    await rejected;
    vi.advanceTimersByTime(60000);
    expect(MockSocket.instances).toHaveLength(1);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close cancels a handshake and an already scheduled reconnect', () => {
    const first = setup(); first.client.close();
    vi.advanceTimersByTime(60000);
    expect(first.onDisconnect).not.toHaveBeenCalled();
    const second = setup(); latest().onerror?.(); second.client.close();
    vi.advanceTimersByTime(60000);
    expect(MockSocket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fences late result/close/error from a retired connection', async () => {
    const { client, onDisconnect } = setup(); latest().ready();
    const oldMessage = latest().onmessage!;
    const oldClose = latest().onclose!;
    const oldError = latest().onerror!;
    const old = client.send(frame, new AbortController().signal)!;
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    client.close(); await rejected;
    client.start(); latest().ready();
    const next = client.send({ ...frame, session_id: 'new' }, new AbortController().signal)!;
    oldMessage({ data: JSON.stringify({ ...result, session_id: 'new' }) });
    oldClose(); oldError();
    expect(client.isReady).toBe(true);
    expect(onDisconnect).not.toHaveBeenCalled();
    latest().message({ ...result, session_id: 'new' });
    await expect(next).resolves.toMatchObject({ session_id: 'new' });
    client.close();
  });

  it('bounds retries to 1/2/4 seconds even if ready succeeds, and error+close counts once', () => {
    const { client, onDisconnect } = setup();
    for (const delay of [1000, 2000, 4000]) {
      latest().ready();
      const count = MockSocket.instances.length;
      const close = latest().onclose!;
      latest().onerror?.(); close();
      vi.advanceTimersByTime(delay - 1); expect(MockSocket.instances).toHaveLength(count);
      vi.advanceTimersByTime(1); expect(MockSocket.instances).toHaveLength(count + 1);
    }
    latest().onclose?.();
    vi.advanceTimersByTime(60000);
    expect(MockSocket.instances).toHaveLength(4);
    expect(onDisconnect).toHaveBeenCalledTimes(4);
    expect(onDisconnect.mock.calls.at(-1)?.[1]).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it.each(['model_auth', 'not_configured', 'realtime_unavailable', 'rate_limited', 'realtime_protocol'])('does not reconnect after terminal %s', async code => {
    const { client, onDisconnect } = setup(); latest().ready();
    const promise = client.send(frame, new AbortController().signal)!;
    const rejected = expect(promise).rejects.toMatchObject({ code });
    latest().message({ type: 'error', error_code: code, message: '终止错误' });
    await rejected; vi.advanceTimersByTime(60000);
    expect(MockSocket.instances).toHaveLength(1);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ code }), false);
    expect(latest().close).toHaveBeenCalledTimes(1);
    client.close();
  });

  it.each(['network_error', 'model_unavailable', 'realtime_expired', 'busy'])('recovers from backend %s using the same bounded budget', code => {
    const { client, onDisconnect } = setup();
    for (const delay of [1000, 2000, 4000]) {
      const count = MockSocket.instances.length;
      latest().message({ type: 'error', error_code: code, message: '临时不可用' });
      expect(onDisconnect.mock.calls.at(-1)?.[1]).toBe(true);
      vi.advanceTimersByTime(delay);
      expect(MockSocket.instances).toHaveLength(count + 1);
    }
    latest().message({ type: 'error', error_code: code, message: '临时不可用' });
    vi.advanceTimersByTime(60000);
    expect(MockSocket.instances).toHaveLength(4);
    expect(onDisconnect.mock.calls.at(-1)?.[1]).toBe(false);
    client.close();
  });

  it('paces frames from the ready-triggered first send rather than the interval clock', async () => {
    const { client } = setup(); latest().ready();
    const first = client.send(frame, new AbortController().signal)!;
    latest().message(result); await first;
    vi.advanceTimersByTime(700);
    expect(client.send({ ...frame, frame_id: 2 }, new AbortController().signal)).toBeNull();
    vi.advanceTimersByTime(300);
    const next = client.send({ ...frame, frame_id: 3 }, new AbortController().signal)!;
    latest().message({ ...result, frame_id: 3 });
    await expect(next).resolves.toMatchObject({ frame_id: 3 });
    expect(latest().send).toHaveBeenCalledTimes(2);
    client.close();
  });

  it('times out a missing ready without sending any images', () => {
    const { client, onDisconnect } = setup();
    vi.advanceTimersByTime(15000);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ code: 'model_timeout' }), true);
    expect(latest().send).not.toHaveBeenCalled();
    client.close();
  });

  it('rejects oversize or data-URL payloads before sending', async () => {
    const { client } = setup(); latest().ready();
    for (const image of ['A'.repeat(MAX_IMAGE_BASE64 + 1), 'data:image/jpeg;base64,/9j/']) {
      await expect(client.send({ ...frame, image }, new AbortController().signal)).rejects.toThrow('未发送');
    }
    expect(latest().send).not.toHaveBeenCalled();
    client.close();
  });
});

describe('captureRealtimeFrame', () => {
  function canvasFixture(encode: (quality: number) => string) {
    const drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toDataURL: vi.fn((_type: string, quality: number) => encode(quality)) };
    vi.stubGlobal('document', { createElement: () => canvas });
    const video = { videoWidth: 1920, videoHeight: 1080, readyState: 2 } as HTMLVideoElement;
    return { canvas, video, drawImage };
  }

  it('captures JPEG at 960px / .65 and returns pure base64', () => {
    const { canvas, video, drawImage } = canvasFixture(() => 'data:image/jpeg;base64,/9j/AAAA');
    expect(captureRealtimeFrame(video)).toBe('/9j/AAAA');
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 960, 540);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.65);
    expect(canvas.width).toBe(0);
  });

  it('reduces quality then scales, and never returns an oversize payload', () => {
    let count = 0;
    const { canvas, video, drawImage } = canvasFixture(() => `data:image/jpeg;base64,${++count < 4 ? 'A'.repeat(MAX_IMAGE_BASE64 + 1) : '/9j/AAAA'}`);
    expect(captureRealtimeFrame(video)).toBe('/9j/AAAA');
    expect(drawImage).toHaveBeenLastCalledWith(video, 0, 0, 720, 405);
    expect(canvas.toDataURL.mock.calls.map(call => call[1])).toEqual([0.65, 0.5, 0.35, 0.65]);
  });

  it('gives an explicit error if compression cannot fit the limit', () => {
    const { canvas, video } = canvasFixture(() => `data:image/jpeg;base64,${'A'.repeat(MAX_IMAGE_BASE64 + 1)}`);
    expect(() => captureRealtimeFrame(video)).toThrow('仍超过 256 KiB，未发送');
    expect(canvas.toDataURL).toHaveBeenCalledTimes(12);
    expect(canvas.width).toBe(0);
  });
});
