import type { Analysis, RealtimeFrame, RealtimeMessage, RealtimeState } from './types';

export const MAX_IMAGE_BASE64 = 256 * 1024;
const FRAME_TIMEOUT = 9000;
// Upstream setup can take 8 seconds; no image is captured during this window.
const READY_TIMEOUT = 15000;
const BACKOFF = [1000, 2000, 4000];
const transient = new Set(['network', 'network_error', 'model_timeout', 'model_unavailable', 'realtime_expired', 'busy']);

export class RealtimeError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'RealtimeError'; }
  get retryable() { return transient.has(this.code); }
}

export function realtimeUrl(location: Pick<Location, 'protocol' | 'host'> = window.location) {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/realtime`;
}

/** Synchronous capture: the timestamp belongs to this image, never to the handshake. */
export function captureRealtimeFrame(video: HTMLVideoElement, flipHorizontal: boolean): string {
  const canvas = document.createElement('canvas');
  try {
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw new Error('当前画面不可用，请重新选择输入。');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法读取当前画面，请检查浏览器画面权限。');
    let scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    for (let attempt = 0; attempt < 4; attempt++, scale *= 0.75) {
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      if (flipHorizontal) context.setTransform(-1, 0, 0, 1, canvas.width, 0);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.65, 0.5, 0.35]) {
        const data = canvas.toDataURL('image/jpeg', quality);
        if (!data.startsWith('data:image/jpeg;base64,')) throw new Error('浏览器无法生成 JPEG 画面。');
        const image = data.slice('data:image/jpeg;base64,'.length);
        if (image.length && image.length <= MAX_IMAGE_BASE64) return image;
      }
    }
    throw new Error('画面压缩后仍超过 256 KiB，未发送。请降低输入分辨率或切换 HTTP 抽帧。');
  } finally { canvas.width = canvas.height = 0; }
}

type Options = {
  onState: (state: RealtimeState) => void;
  onReady: () => void;
  onResult: (result: Analysis, capturedAt: number) => void;
  onDisconnect: (error: RealtimeError, retrying: boolean) => void;
};
const MAX_TRACKED_FRAMES = 16;

/** Paced continuous sends; retain only bounded metadata, never an image queue. */
export class RealtimeClient {
  private socket: WebSocket | null = null;
  private outstanding = new Map<number, { session: string; capturedAt: number }>();
  private session: string | null = null;
  private lastFrameId = 0;
  private frameTimer?: ReturnType<typeof setTimeout>;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private enabled = false;
  private attempts = 0;
  private lastSentAt = -Infinity;
  private state: RealtimeState = 'waiting';

  constructor(private options: Options) {}
  get isReady() { return this.state === 'connected' && this.socket?.readyState === WebSocket.OPEN; }
  get canSend() { return this.isReady && this.socket!.bufferedAmount === 0 && Date.now() - this.lastSentAt >= 1000; }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.attempts = 0;
    this.open();
  }

  private update(state: RealtimeState) { this.state = state; this.options.onState(state); }

  private open() {
    if (!this.enabled) return;
    this.update(this.attempts ? 'recovering' : 'connecting');
    if (!this.enabled) return;
    let socket: WebSocket;
    try { socket = new WebSocket(realtimeUrl()); }
    catch { this.fail(new RealtimeError('network', '无法建立实时连接。')); return; }
    this.socket = socket;
    this.lastSentAt = -Infinity;
    const current = () => this.enabled && this.socket === socket;
    this.readyTimer = setTimeout(() => {
      if (current()) this.fail(new RealtimeError('model_timeout', '实时连接握手超时。'));
    }, READY_TIMEOUT);
    socket.onmessage = event => {
      if (!current()) return;
      let message: RealtimeMessage;
      try { message = JSON.parse(String(event.data)); }
      catch { this.fail(new RealtimeError('protocol', '实时服务返回了无效消息。')); return; }
      if (!message || typeof message !== 'object') { this.fail(new RealtimeError('protocol', '实时服务消息格式不正确。')); return; }
      if (message.type === 'ready') {
        if (this.state === 'connected') return;
        clearTimeout(this.readyTimer); this.readyTimer = undefined;
        this.update('connected');
        if (current()) this.options.onReady();
      } else if (message.type === 'error') {
        this.fail(new RealtimeError(message.error_code, message.message || '实时识别不可用。'));
      } else if (message.type === 'result') {
        const metadata = this.outstanding.get(message.frame_id);
        if (!metadata || message.session_id !== this.session || message.session_id !== metadata.session) return;
        if (!Array.isArray(message.events) || !['ok', 'uncertain', 'error'].includes(message.status)) {
          this.fail(new RealtimeError('protocol', '实时识别响应格式不正确。')); return;
        }
        if (message.status === 'error') {
          this.fail(new RealtimeError(message.error_code ?? 'protocol', message.message || '实时识别不可用。')); return;
        }
        // A newer result also retires pending frames dropped by the backend.
        for (const id of this.outstanding.keys()) if (id <= message.frame_id) this.outstanding.delete(id);
        this.watchProgress();
        this.options.onResult(message, metadata.capturedAt);
      }
    };
    // Detach and fence before close: error + close must consume just one retry.
    socket.onerror = () => { if (current()) this.fail(new RealtimeError('network', '实时连接发生网络错误。')); };
    socket.onclose = () => { if (current()) this.fail(new RealtimeError('network', '实时连接已断开。')); };
  }

  send(frame: RealtimeFrame, capturedAt: number): boolean {
    if (!this.canSend) return false;
    if (typeof frame.image !== 'string' || !frame.image.startsWith('/9j/') || frame.image.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.image)) {
      throw new Error('画面不是有效的限额内纯 base64 JPEG，未发送。');
    }
    if (frame.type !== 'frame' || frame.mode !== 'walk' || !['camera', 'video'].includes(frame.source)
      || typeof frame.session_id !== 'string' || !frame.session_id || (this.session !== null && frame.session_id !== this.session)
      || !Number.isSafeInteger(frame.frame_id) || frame.frame_id <= this.lastFrameId || !Number.isFinite(capturedAt)) {
      throw new Error('实时画面元数据无效；切换会话前请关闭连接，未发送。');
    }
    try { this.socket!.send(JSON.stringify(frame)); }
    catch { this.fail(new RealtimeError('network', '实时画面发送失败。')); return false; }
    this.lastSentAt = Date.now();
    this.lastFrameId = frame.frame_id;
    this.session = frame.session_id;
    this.outstanding.set(frame.frame_id, { session: frame.session_id, capturedAt });
    if (this.outstanding.size > MAX_TRACKED_FRAMES) this.outstanding.delete(this.outstanding.keys().next().value!);
    // Sending more images is not analysis progress and must not defer the watchdog.
    if (!this.frameTimer) this.watchProgress();
    return true;
  }

  private watchProgress() {
    clearTimeout(this.frameTimer); this.frameTimer = undefined;
    if (this.outstanding.size) {
      this.frameTimer = setTimeout(() => this.fail(new RealtimeError('model_timeout', '实时识别超过 9 秒未返回新结果，已断开。')), FRAME_TIMEOUT);
    }
  }

  private retire() {
    clearTimeout(this.readyTimer); this.readyTimer = undefined;
    clearTimeout(this.frameTimer); this.frameTimer = undefined;
    this.outstanding.clear(); this.session = null; this.lastFrameId = 0; this.lastSentAt = -Infinity;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onmessage = socket.onerror = socket.onclose = socket.onopen = null;
      socket.close();
    }
  }

  private fail(error: RealtimeError) {
    if (!this.enabled) return;
    this.retire();
    const retrying = error.retryable && this.attempts < BACKOFF.length;
    if (retrying) {
      const delay = BACKOFF[this.attempts++];
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.open(); }, delay);
    } else this.enabled = false;
    this.update(retrying ? 'recovering' : 'disconnected');
    this.options.onDisconnect(error, retrying);
  }

  close() {
    this.enabled = false;
    clearTimeout(this.retryTimer); this.retryTimer = undefined;
    this.retire();
    this.update('disconnected');
  }
}
