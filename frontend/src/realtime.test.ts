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
// Inspect the retention boundary, not the mock socket's recorded wire payloads.
const metadata = (client: RealtimeClient) => (client as unknown as { outstanding: Map<number, { session: string; capturedAt: number }> }).outstanding;
function setup() {
  const callbacks = { onState: vi.fn(), onReady: vi.fn(), onResult: vi.fn(), onDisconnect: vi.fn() };
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
    expect(client.canSend).toBe(false);
    expect(client.send(frame, Date.now())).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
    socket.ready(); socket.ready();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(client.isReady).toBe(true);
    expect(client.canSend).toBe(true);
    client.close();
  });

  it('sends frames 2/3 before result 1 and accepts result 3 without result 2', () => {
    const { client, onResult } = setup(); latest().ready();
    const timestamps: number[] = [];
    for (let id = 1; id <= 3; id++) {
      timestamps.push(Date.now());
      expect(client.send({ ...frame, frame_id: id }, Date.now())).toBe(true);
      if (id < 3) vi.advanceTimersByTime(1000);
    }
    expect(latest().send).toHaveBeenCalledTimes(3);
    expect(onResult).not.toHaveBeenCalled();
    expect(JSON.parse(latest().send.mock.calls[0][0])).toEqual(frame);
    latest().message(result);
    expect(onResult).toHaveBeenLastCalledWith(result, timestamps[0]);
    expect([...metadata(client).keys()]).toEqual([2, 3]);
    latest().message({ ...result, frame_id: 3 });
    expect(onResult).toHaveBeenLastCalledWith({ ...result, frame_id: 3 }, timestamps[2]);
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(metadata(client).size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it('ignores foreign, unsent, duplicate and out-of-order results, including their errors', () => {
    const { client, onResult, onDisconnect } = setup(); latest().ready();
    client.send(frame, Date.now());
    vi.advanceTimersByTime(1000); client.send({ ...frame, frame_id: 3 }, Date.now());
    latest().message({ ...result, session_id: 'foreign', status: 'error' });
    latest().message({ ...result, frame_id: 2 });
    latest().message({ ...result, frame_id: 999 });
    expect(onResult).not.toHaveBeenCalled();
    latest().message({ ...result, frame_id: 3 });
    latest().message({ ...result, frame_id: 3 });
    latest().message({ ...result, status: 'error' });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(metadata(client).size).toBe(0);
    client.close();
  });

  it('paces from the actual send and drops backpressured work without queuing it', () => {
    const { client } = setup(); latest().ready();
    client.send(frame, Date.now());
    vi.advanceTimersByTime(999);
    expect(client.canSend).toBe(false);
    expect(client.send({ ...frame, frame_id: 2 }, Date.now())).toBe(false);
    vi.advanceTimersByTime(1);
    latest().bufferedAmount = 1;
    expect(client.canSend).toBe(false);
    expect(client.send({ ...frame, frame_id: 3 }, Date.now())).toBe(false);
    latest().bufferedAmount = 0;
    expect(client.canSend).toBe(true);
    expect(latest().send).toHaveBeenCalledTimes(1);
    expect(client.send({ ...frame, frame_id: 4 }, Date.now())).toBe(true);
    expect([...metadata(client).keys()]).toEqual([1, 4]);
    client.close();
  });

  it('starts the nine-second watchdog after ready; further sends and invalid results cannot postpone it', () => {
    const { client, onDisconnect } = setup();
    vi.advanceTimersByTime(8000); latest().ready();
    const first = latest();
    client.send(frame, Date.now());
    for (let id = 2; id <= 9; id++) {
      vi.advanceTimersByTime(1000);
      expect(client.send({ ...frame, frame_id: id }, Date.now())).toBe(true);
      first.message({ ...result, session_id: 'foreign', frame_id: id });
      first.message({ ...result, frame_id: 999 });
    }
    vi.advanceTimersByTime(999); expect(first.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ code: 'model_timeout' }), true);
    expect(metadata(client).size).toBe(0);
    vi.advanceTimersByTime(1000); latest().ready();
    expect(latest().send).not.toHaveBeenCalled();
    expect(client.canSend).toBe(true);
    client.close();
  });

  it('renews the watchdog from valid progress, not the oldest remaining capture', () => {
    const { client, onDisconnect, onResult } = setup(); latest().ready();
    const capturedAt = Date.now();
    client.send(frame, capturedAt);
    vi.advanceTimersByTime(1000); client.send({ ...frame, frame_id: 2 }, Date.now());
    vi.advanceTimersByTime(7000); latest().message(result);
    expect(onResult).toHaveBeenCalledWith(result, capturedAt);
    vi.advanceTimersByTime(1000); client.send({ ...frame, frame_id: 3 }, Date.now());
    latest().message(result); // Duplicate progress cannot renew the deadline either.
    vi.advanceTimersByTime(7999);
    expect(onDisconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ code: 'model_timeout' }), true);
    client.close();
  });

  it('clears the watchdog when a result covers all outstanding frames and restarts for fresh work', () => {
    const { client, onDisconnect } = setup(); latest().ready();
    client.send(frame, Date.now());
    vi.advanceTimersByTime(8000); latest().message(result);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30000);
    expect(onDisconnect).not.toHaveBeenCalled();
    client.send({ ...frame, frame_id: 2 }, Date.now());
    vi.advanceTimersByTime(8999); expect(onDisconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(onDisconnect).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('retains at most 16 metadata entries, never image bytes, and forgets everything on close', () => {
    const { client, onResult } = setup(); latest().ready();
    for (let id = 1; id <= 40; id++) {
      if (id > 1) vi.advanceTimersByTime(1000);
      client.send({ ...frame, frame_id: id }, Date.now());
      expect(metadata(client).size).toBeLessThanOrEqual(16);
      for (const entry of metadata(client).values()) {
        expect(entry).toEqual({ session: frame.session_id, capturedAt: expect.any(Number) });
      }
      // Slow valid progress lets outstanding metadata reach the bound.
      if (id % 8 === 0) latest().message({ ...result, frame_id: Math.max(id - 15, id / 8) });
    }
    expect(metadata(client).size).toBe(15);
    expect(JSON.stringify([...metadata(client)])).not.toContain(frame.image);
    const count = onResult.mock.calls.length;
    latest().message({ ...result, frame_id: 8 }); // Evicted, not an accepted turn.
    expect(onResult).toHaveBeenCalledTimes(count);
    client.close();
    expect(metadata(client).size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    client.start(); latest().ready();
    expect(latest().send).not.toHaveBeenCalled();
    latest().message({ ...result, frame_id: 40 });
    expect(onResult).toHaveBeenCalledTimes(count);
    client.close();
  });

  it('close clears outstanding work and cancels all timers without disconnect callbacks', () => {
    const { client, onDisconnect, onResult } = setup(); latest().ready();
    client.send(frame, Date.now());
    const late = latest().onmessage!;
    client.close();
    late({ data: JSON.stringify(result) });
    vi.advanceTimersByTime(60000);
    expect(client.canSend).toBe(false);
    expect(metadata(client).size).toBe(0);
    expect(MockSocket.instances).toHaveLength(1);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
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

  it('fences late ready/result/close/error from a retired connection, even with reused IDs', () => {
    const { client, onDisconnect, onResult, onReady } = setup(); latest().ready();
    const oldMessage = latest().onmessage!;
    const oldClose = latest().onclose!;
    const oldError = latest().onerror!;
    client.send(frame, Date.now());
    client.close(); client.start(); latest().ready();
    const capturedAt = Date.now();
    client.send(frame, capturedAt);
    oldMessage({ data: JSON.stringify({ type: 'ready' }) });
    oldMessage({ data: JSON.stringify(result) });
    oldClose(); oldError();
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(client.isReady).toBe(true);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    latest().message(result);
    expect(onResult).toHaveBeenCalledWith(result, capturedAt);
    client.close();
  });

  it('permits callbacks to close during readiness, results or recovery without leaked timers', () => {
    const ready = setup();
    ready.onState.mockImplementation(state => { if (state === 'connected') ready.client.close(); });
    latest().ready();
    expect(ready.onReady).not.toHaveBeenCalled();
    const receiving = setup(); latest().ready();
    receiving.client.send(frame, Date.now());
    vi.advanceTimersByTime(1000); receiving.client.send({ ...frame, frame_id: 2 }, Date.now());
    receiving.onResult.mockImplementation(() => receiving.client.close());
    latest().message(result);
    expect(metadata(receiving.client).size).toBe(0);
    const recovering = setup();
    recovering.onDisconnect.mockImplementation(() => recovering.client.close());
    latest().onerror?.();
    vi.advanceTimersByTime(60000);
    expect(MockSocket.instances).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds retries to 1/2/4 seconds despite ready/progress, counts error+close once, and resets on restart', () => {
    const { client, onDisconnect } = setup();
    for (const delay of [1000, 2000, 4000]) {
      latest().ready();
      client.send(frame, Date.now()); latest().message(result);
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
    client.start(); latest().onerror?.();
    vi.advanceTimersByTime(1000);
    expect(MockSocket.instances).toHaveLength(6);
    client.close();
  });

  it.each(['model_auth', 'not_configured', 'realtime_unavailable', 'rate_limited', 'realtime_protocol'])('does not reconnect after terminal %s', code => {
    const { client, onDisconnect, onResult } = setup(); latest().ready();
    client.send(frame, Date.now());
    latest().message({ type: 'error', error_code: code, message: '终止错误' });
    vi.advanceTimersByTime(60000);
    expect(MockSocket.instances).toHaveLength(1);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ code }), false);
    expect(onResult).not.toHaveBeenCalled();
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

  it('times out missing ready at 15 seconds without sending images', () => {
    const { client, onDisconnect } = setup();
    vi.advanceTimersByTime(14999);
    expect(onDisconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ code: 'model_timeout' }), true);
    expect(latest().send).not.toHaveBeenCalled();
    client.close();
  });

  it('throws on invalid image input and accepts an in-limit pure base64 JPEG', () => {
    const { client } = setup(); latest().ready();
    for (const image of ['', '/9j/' + 'A'.repeat(MAX_IMAGE_BASE64), 'data:image/jpeg;base64,/9j/', '/9j/%%%', 'AAAA']) {
      expect(() => client.send({ ...frame, image }, Date.now())).toThrow('未发送');
    }
    expect(latest().send).not.toHaveBeenCalled();
    expect(metadata(client).size).toBe(0);
    expect(client.send({ ...frame, image: '/9j/' + 'A'.repeat(MAX_IMAGE_BASE64 - 4) }, Date.now())).toBe(true);
    client.close();
  });

  it('rejects invalid metadata and requires closing before changing session or reusing IDs', () => {
    const { client } = setup(); latest().ready();
    expect(() => client.send(frame, NaN)).toThrow('元数据无效');
    expect(() => client.send({ ...frame, frame_id: 1.5 }, Date.now())).toThrow('元数据无效');
    expect(() => client.send({ ...frame, session_id: '' }, Date.now())).toThrow('元数据无效');
    client.send(frame, Date.now());
    vi.advanceTimersByTime(1000);
    expect(() => client.send(frame, Date.now())).toThrow('元数据无效');
    expect(() => client.send({ ...frame, session_id: 'new', frame_id: 2 }, Date.now())).toThrow('元数据无效');
    client.close(); client.start(); latest().ready();
    expect(client.send({ ...frame, session_id: 'new' }, Date.now())).toBe(true);
    client.close();
  });

  it('reports synchronous socket send failure through onDisconnect and never replays it', () => {
    const { client, onDisconnect } = setup(); latest().ready();
    latest().send.mockImplementation(() => { throw new Error('socket closed'); });
    expect(client.send(frame, Date.now())).toBe(false);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ code: 'network' }), true);
    expect(metadata(client).size).toBe(0);
    vi.advanceTimersByTime(1000); latest().ready();
    expect(latest().send).not.toHaveBeenCalled();
    client.close();
  });

  it.each([null, 'invalid-json', { ...result, events: null }, { ...result, status: 'bad' }, { ...result, status: 'error', error_code: 'protocol' }])('disconnects for invalid matched protocol data: %j', message => {
    const { client, onDisconnect, onResult } = setup(); latest().ready();
    client.send(frame, Date.now());
    if (message === 'invalid-json') latest().onmessage?.({ data: 'not JSON' });
    else latest().message(message);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ code: 'protocol' }), false);
    expect(onResult).not.toHaveBeenCalled();
    expect(metadata(client).size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });
});

describe('captureRealtimeFrame', () => {
  function canvasFixture(encode: (quality: number) => string) {
    const drawImage = vi.fn();
    const setTransform = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage, setTransform }), toDataURL: vi.fn((_type: string, quality: number) => encode(quality)) };
    vi.stubGlobal('document', { createElement: () => canvas });
    const video = { videoWidth: 1920, videoHeight: 1080, readyState: 2 } as HTMLVideoElement;
    return { canvas, video, drawImage, setTransform };
  }

  it('captures unflipped video JPEG at 960px / .65 and returns pure base64', () => {
    const { canvas, video, drawImage, setTransform } = canvasFixture(() => 'data:image/jpeg;base64,/9j/AAAA');
    expect(captureRealtimeFrame(video, false)).toBe('/9j/AAAA');
    expect(setTransform).not.toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 960, 540);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.65);
    expect(canvas.width).toBe(0);
  });

  it('flips camera pixels horizontally before drawing', () => {
    const { video, drawImage, setTransform } = canvasFixture(() => 'data:image/jpeg;base64,/9j/AAAA');
    expect(captureRealtimeFrame(video, true)).toBe('/9j/AAAA');
    expect(setTransform).toHaveBeenCalledExactlyOnceWith(-1, 0, 0, 1, 960, 0);
    expect(setTransform.mock.invocationCallOrder[0]).toBeLessThan(drawImage.mock.invocationCallOrder[0]);
  });

  it.each([false, true])('reduces quality then scales without losing flip=%s', flipHorizontal => {
    let count = 0;
    const { canvas, video, drawImage, setTransform } = canvasFixture(() => `data:image/jpeg;base64,${++count < 4 ? 'A'.repeat(MAX_IMAGE_BASE64 + 1) : '/9j/AAAA'}`);
    expect(captureRealtimeFrame(video, flipHorizontal)).toBe('/9j/AAAA');
    expect(drawImage).toHaveBeenLastCalledWith(video, 0, 0, 720, 405);
    expect(setTransform.mock.calls).toEqual(flipHorizontal ? [[-1, 0, 0, 1, 960, 0], [-1, 0, 0, 1, 720, 0]] : []);
    expect(canvas.toDataURL.mock.calls.map(call => call[1])).toEqual([0.65, 0.5, 0.35, 0.65]);
  });

  it('gives an explicit error if compression cannot fit the limit', () => {
    const { canvas, video } = canvasFixture(() => `data:image/jpeg;base64,${'A'.repeat(MAX_IMAGE_BASE64 + 1)}`);
    expect(() => captureRealtimeFrame(video, true)).toThrow('仍超过 256 KiB，未发送');
    expect(canvas.toDataURL).toHaveBeenCalledTimes(12);
    expect(canvas.width).toBe(0);
  });
});
