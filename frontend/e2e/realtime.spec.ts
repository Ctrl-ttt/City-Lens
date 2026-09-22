import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import type { Health, RealtimeFrame } from '../src/types';

declare global {
  interface Window { __spoken: string[]; __cancelled: number; __captures: number }
}
const health: Health = { status: 'ok', provider: 'realtime', model: 'realtime-test', configured: true, sample_scene: null, http_model: 'http-test', http_configured: true, realtime_model: 'realtime-test', realtime_configured: true };
type Connection = { route: WebSocketRoute; frames: RealtimeFrame[]; closed: boolean };
function respond(connection: Connection, frame: Pick<RealtimeFrame, 'session_id' | 'frame_id'>, text = '右前方发现自行车') {
  connection.route.send(JSON.stringify({ type: 'result', ...analysis(frame, text) }));
}
function analysis(frame: Pick<RealtimeFrame, 'session_id' | 'frame_id'>, text: string) {
  return { session_id: frame.session_id, frame_id: frame.frame_id, status: 'ok', events: [{ category: 'obstacle', label: 'bicycle', direction: 'right', text }], speech: { key: text, priority: 'normal', text }, latency_ms: 100 };
}
async function setup(page: Page, options: { health?: Partial<Health>; ready?: boolean; results?: boolean } = {}) {
  const connections: Connection[] = [];
  const http: { mode: string; source: string; closedBeforeHttp: boolean }[] = [];
  // Only replace the OS speech engine. The real SpeechQueue, driver and Canvas run.
  await page.addInitScript(() => {
    window.__spoken = []; window.__cancelled = 0; window.__captures = 0;
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(public text: string) {} } });
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [{ name: '测试中文语音', lang: 'zh-CN', localService: true }],
      addEventListener() {}, removeEventListener() {},
      speak(utterance: SpeechSynthesisUtterance) { window.__spoken.push(utterance.text); queueMicrotask(() => utterance.onend?.call(utterance, {} as SpeechSynthesisEvent)); },
      cancel() { window.__cancelled++; },
    } });
    const encode = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) { window.__captures++; return encode.apply(this, args); };
  });
  await page.route('**/api/health', route => route.fulfill({ json: { ...health, ...options.health } }));
  await page.route('**/api/analyze', route => {
    const body = route.request().postDataBuffer()!.toString('latin1');
    const field = (name: string) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]+)`))?.[1] ?? '';
    http.push({ mode: field('mode'), source: field('source'), closedBeforeHttp: connections.every(c => c.closed) });
    return route.fulfill({ json: analysis({ session_id: field('session_id'), frame_id: Number(field('frame_id')) }, field('mode') === 'read' ? '标牌文字：测试路' : 'HTTP 当前画面') });
  });
  await page.routeWebSocket('**/api/realtime', route => {
    const connection: Connection = { route, frames: [], closed: false };
    connections.push(connection);
    route.onClose(() => { connection.closed = true; });
    route.onMessage(message => {
      const frame: RealtimeFrame = JSON.parse(String(message));
      connection.frames.push(frame);
      if (options.results !== false) respond(connection, frame);
    });
    if (options.ready !== false) route.send(JSON.stringify({ type: 'ready' }));
  });
  await page.goto('/');
  if (options.health?.provider === 'sample') await expect(page.getByText('样例联调模式 · 不是实际识别')).toBeVisible();
  else await expect(page.getByRole('button', { name: '实时连接', exact: true })).toBeVisible();
  return { connections, http };
}
async function consentAndStart(page: Page) {
  await page.getByRole('checkbox', { name: /我了解抽帧/ }).check();
  await page.getByRole('button', { name: '▶ 开始识别', exact: true }).click();
}
const state = (page: Page) => page.getByRole('status', { name: '实时连接状态' });
const caption = (page: Page) => page.locator('.live-caption');

test('default channel, consent, eight-second ready gate, real canvas/TTS, pause and resume', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { connections } = await setup(page, { ready: false });
  await expect(page.getByRole('button', { name: '实时连接', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(state(page)).toHaveText('实时连接：待连接');
  await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeDisabled();
  expect(connections).toHaveLength(0);
  await consentAndStart(page);
  await expect.poll(() => connections.length).toBe(1);
  await page.clock.install();
  await page.clock.runFor(8000);
  await expect(state(page)).toHaveText('实时连接：连接中');
  expect(connections[0].frames).toHaveLength(0);
  expect(await page.evaluate(() => window.__captures)).toBe(0);
  connections[0].route.send('{"type":"ready"}');
  await expect(caption(page)).toHaveText('右前方发现自行车');
  await expect(state(page)).toHaveText('实时连接：已连接');
  expect(await page.evaluate(() => window.__spoken)).toEqual(['右前方发现自行车']);
  const frame = connections[0].frames[0];
  expect(Object.keys(frame).sort()).toEqual(['frame_id', 'image', 'mode', 'session_id', 'source', 'type']);
  expect(frame).toMatchObject({ type: 'frame', mode: 'walk', source: 'camera', frame_id: 1 });
  expect(frame.image.length).toBeLessThanOrEqual(256 * 1024);
  expect(Buffer.from(frame.image, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  const longest = await page.evaluate(async image => {
    const img = new Image(); img.src = `data:image/jpeg;base64,${image}`; await img.decode(); return Math.max(img.width, img.height);
  }, frame.image);
  expect(longest).toBeLessThanOrEqual(960);
  expect(await page.locator('video').evaluate(v => ((v as HTMLVideoElement).srcObject as MediaStream).getAudioTracks().length)).toBe(0);
  await expect(page.locator('.quiet-note').filter({ hasText: '未使用麦克风' })).toBeVisible();
  // Same speech key within 8s is deduplicated by the real queue.
  await page.clock.runFor(1000);
  await expect.poll(() => connections[0].frames.length).toBe(2);
  expect(await page.evaluate(() => window.__spoken)).toHaveLength(1);
  await page.getByRole('button', { name: 'Ⅱ 暂停识别' }).click();
  await expect.poll(() => connections[0].closed).toBe(true);
  const count = connections[0].frames.length;
  await page.clock.runFor(5000);
  expect(connections[0].frames).toHaveLength(count);
  expect(connections).toHaveLength(1);
  await expect(page.locator('.event-list')).toBeEmpty();
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect.poll(() => connections.length).toBe(2);
  connections[1].route.send('{"type":"ready"}');
  await expect(caption(page)).toHaveText('右前方发现自行车');
  expect(connections[1].frames[0].session_id).not.toBe(frame.session_id);
  expect(errors).toEqual([]);
});

test('live default allows realtime and switching channels stops without automatic restart', async ({ page }) => {
  const { connections, http } = await setup(page, { health: { provider: 'live', model: 'http-test' } });
  await expect(page.getByRole('button', { name: 'HTTP 抽帧', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '实时连接', exact: true }).click();
  await consentAndStart(page);
  await expect(caption(page)).toHaveText('右前方发现自行车');
  await page.getByRole('button', { name: 'HTTP 抽帧', exact: true }).click();
  await expect(caption(page)).toHaveText('识别通道已切换，请重新开始');
  await expect.poll(() => connections[0].closed).toBe(true);
  await expect(page.getByRole('button', { name: '重播上一条' })).toBeDisabled();
  expect(http).toHaveLength(0);
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect(caption(page)).toHaveText('HTTP 当前画面');
  expect(http[0]).toMatchObject({ mode: 'walk', source: 'camera' });
  expect(connections).toHaveLength(1);
});

test('realtime capability is independent of an unconfigured HTTP default', async ({ page }) => {
  await setup(page, { health: { provider: 'live', configured: false, http_configured: false } });
  await page.getByRole('checkbox', { name: /我了解抽帧/ }).check();
  await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeDisabled();
  await page.getByRole('button', { name: '实时连接', exact: true }).click();
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect(caption(page)).toHaveText('右前方发现自行车');
  await expect(page.getByRole('button', { name: '看牌 · 读取文字' })).toBeDisabled();
});

test('read interrupts an in-flight realtime frame and uses HTTP without an idle socket', async ({ page }) => {
  const { connections, http } = await setup(page, { results: false });
  await consentAndStart(page);
  await expect.poll(() => connections[0]?.frames.length).toBe(1);
  const old = connections[0].frames[0];
  await page.getByRole('button', { name: '看牌 · 读取文字' }).click();
  await expect(caption(page)).toHaveText('标牌文字：测试路');
  await expect.poll(() => connections[0].closed).toBe(true);
  await expect(state(page)).toHaveText('实时连接：已断开');
  expect(http).toEqual([{ mode: 'read', source: 'camera', closedBeforeHttp: true }]);
  await page.clock.install(); await page.clock.runFor(10000);
  expect(connections).toHaveLength(1);
  await page.getByRole('button', { name: '▶ 返回环境识别' }).click();
  await expect.poll(() => connections[1]?.frames.length).toBe(1);
  respond(connections[1], old, '旧帧不得显示或播报');
  respond(connections[1], { ...connections[1].frames[0], frame_id: 999 }, '错帧不得显示');
  await page.clock.runFor(100);
  expect(await page.evaluate(() => window.__spoken)).toEqual(['标牌文字：测试路']);
  await expect(page.locator('.event-list')).toBeEmpty();
  respond(connections[1], connections[1].frames[0], '新的当前画面');
  await expect(caption(page)).toHaveText('新的当前画面');
});

test('single-frame keypress closes immediately after analysis', async ({ page }) => {
  const { connections } = await setup(page);
  await page.getByRole('checkbox', { name: /我了解抽帧/ }).check();
  await page.getByRole('checkbox', { name: '只用按键识别' }).check();
  await page.getByRole('button', { name: '识别当前环境', exact: true }).click();
  await expect(caption(page)).toHaveText('右前方发现自行车');
  await expect.poll(() => connections[0].closed).toBe(true);
  await expect(state(page)).toHaveText('实时连接：已断开');
  await page.clock.install(); await page.clock.runFor(10000);
  expect(connections).toHaveLength(1);
  expect(connections[0].frames).toHaveLength(1);
});

test('disconnect clears speech/results and recovery captures a new frame, with a bounded retry budget', async ({ page }) => {
  const { connections } = await setup(page, { ready: false, results: false });
  await consentAndStart(page);
  await expect.poll(() => connections.length).toBe(1);
  connections[0].route.send('{"type":"ready"}');
  await expect.poll(() => connections[0].frames.length).toBe(1);
  const old = connections[0].frames[0];
  respond(connections[0], old);
  await expect(caption(page)).toHaveText('右前方发现自行车');
  const cancels = await page.evaluate(() => window.__cancelled);
  await page.clock.install();
  for (const [index, delay] of [1000, 2000, 4000].entries()) {
    connections[index].route.close();
    await expect(state(page)).toHaveText('实时连接：恢复中');
    await expect(page.locator('.event-list')).toBeEmpty();
    await expect(page.getByRole('button', { name: '重播上一条' })).toBeDisabled();
    // Exact millisecond boundaries are covered by Vitest's frozen clock.
    await page.clock.runFor(delay); await expect.poll(() => connections.length).toBe(index + 2);
    connections[index + 1].route.send('{"type":"ready"}');
    await expect.poll(() => connections[index + 1].frames.length).toBe(1);
    expect(connections[index + 1].frames[0].session_id).not.toBe(old.session_id);
  }
  connections[3].route.close();
  await expect(state(page)).toHaveText('实时连接：已断开');
  await expect(page.getByRole('alert')).toContainText('HTTP 抽帧');
  await page.clock.runFor(30000);
  expect(connections).toHaveLength(4);
  expect(await page.evaluate(() => window.__spoken)).toEqual(['右前方发现自行车']);
  expect(await page.evaluate(() => window.__cancelled)).toBeGreaterThan(cancels);
  await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeVisible();
});

test('frame deadline discards timed-out work; stale walk results never speak', async ({ page }) => {
  const { connections } = await setup(page, { results: false });
  await consentAndStart(page);
  await expect.poll(() => connections[0]?.frames.length).toBe(1);
  await page.clock.install();
  await page.clock.runFor(6100);
  respond(connections[0], connections[0].frames[0], '过期画面');
  await expect(page.getByRole('alert')).toContainText('结果已过期');
  expect(await page.evaluate(() => window.__spoken)).toEqual([]);
  await page.clock.runFor(1000);
  await expect.poll(() => connections[0].frames.length).toBe(2);
  await page.clock.runFor(9000);
  await expect(state(page)).toHaveText('实时连接：恢复中');
  await expect.poll(() => connections[0].closed).toBe(true);
  await page.clock.runFor(1000);
  await expect.poll(() => connections[1]?.frames.length).toBe(1);
  respond(connections[1], connections[1].frames[0], '恢复后的新画面');
  await expect(caption(page)).toHaveText('恢复后的新画面');
  expect(await page.evaluate(() => window.__spoken)).toEqual(['恢复后的新画面']);
});

for (const action of ['pause', 'stop', 'source', 'consent', 'hidden'] as const) {
  test(`${action} cancels scheduled recovery and never reopens a socket`, async ({ page }) => {
    const { connections } = await setup(page, { results: false });
    await consentAndStart(page);
    await expect.poll(() => connections[0]?.frames.length).toBe(1);
    await page.clock.install();
    connections[0].route.close();
    await expect(state(page)).toHaveText('实时连接：恢复中');
    if (action === 'pause') await page.getByRole('button', { name: 'Ⅱ 暂停识别' }).click();
    if (action === 'stop') await page.getByRole('button', { name: '停止并释放输入' }).click();
    if (action === 'source') await page.getByRole('button', { name: '路线视频回放', exact: true }).click();
    if (action === 'consent') await page.getByRole('checkbox', { name: /我了解抽帧/ }).uncheck();
    if (action === 'hidden') await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.clock.runFor(30000);
    expect(connections).toHaveLength(1);
    await expect(state(page)).toHaveText('实时连接：已断开');
    await expect(page.locator('.event-list')).toBeEmpty();
    expect(await page.evaluate(() => window.__spoken)).toEqual([]);
  });
}

test('terminal errors suggest HTTP without retrying or falling back to sample', async ({ page }) => {
  const { connections, http } = await setup(page, { results: false });
  await consentAndStart(page);
  await expect.poll(() => connections[0]?.frames.length).toBe(1);
  connections[0].route.send(JSON.stringify({ type: 'error', error_code: 'model_auth', message: '实时模型鉴权失败' }));
  await expect(page.getByRole('alert')).toContainText('实时模型鉴权失败');
  await expect(page.getByRole('alert')).toContainText('HTTP 抽帧');
  await expect.poll(() => connections[0].closed).toBe(true);
  await page.clock.install(); await page.clock.runFor(30000);
  expect(connections).toHaveLength(1); expect(http).toHaveLength(0);
  await expect(page.getByText('样例联调模式 · 不是实际识别')).toHaveCount(0);
});

test('sample provider prohibits realtime even when realtime credentials are configured', async ({ page }) => {
  const { connections, http } = await setup(page, { health: { provider: 'sample', sample_scene: 'bicycle', realtime_configured: true } });
  await expect(page.getByRole('button', { name: '实时连接', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /我了解当前/ }).check();
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect(caption(page)).toHaveText('HTTP 当前画面');
  expect(http[0]).toMatchObject({ mode: 'walk', source: 'camera' });
  expect(connections.length).toBe(0);
  await page.getByRole('button', { name: '看牌 · 读取文字' }).click();
  await expect(caption(page)).toHaveText('标牌文字：测试路');
  await page.getByRole('button', { name: '停止并释放输入' }).click();
  await expect(caption(page)).toHaveText('已停止，摄像头已释放');
  expect(connections.length).toBe(0);
});

test('mobile controls, large text and high contrast do not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.getByRole('button', { name: '大字', exact: true }).click();
  await page.getByRole('button', { name: '高对比', exact: true }).click();
  await expect(state(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('local video shares realtime capture and invalidates seeking/ending', async ({ page }) => {
  const { connections } = await setup(page, { results: false });
  // Same synthetic canvas/MediaRecorder fixture approach as the existing video E2E.
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const context = canvas.getContext('2d')!;
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4' });
    const chunks: Blob[] = [];
    const result = new Promise<number[]>(resolve => {
      recorder.ondataavailable = event => chunks.push(event.data);
      recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())));
    });
    const timer = setInterval(() => { context.fillStyle = '#087a61'; context.fillRect(0, 0, 160, 90); context.fillStyle = 'white'; context.fillText(String(Date.now()), 10, 40); }, 80);
    recorder.start(); await new Promise(resolve => setTimeout(resolve, 2000));
    recorder.stop(); clearInterval(timer); stream.getTracks().forEach(track => track.stop());
    return result;
  });
  await page.getByRole('button', { name: '路线视频回放', exact: true }).click();
  await page.getByLabel('选择 MP4 视频').setInputFiles({ name: 'synthetic.mp4', mimeType: 'video/mp4', buffer: Buffer.from(bytes) });
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole('checkbox', { name: /我了解抽帧/ }).check();
  await page.getByRole('checkbox', { name: '只用按键识别' }).check();
  await page.getByRole('button', { name: '识别当前环境', exact: true }).click();
  await expect.poll(() => connections[0]?.frames.length).toBe(1);
  expect(connections[0].frames[0].source).toBe('video');
  await page.locator('video').evaluate(v => { (v as HTMLVideoElement).currentTime = 0.5; });
  await expect(caption(page)).toContainText('视频位置已改变');
  await expect.poll(() => connections[0].closed).toBe(true);
  await page.getByRole('button', { name: '识别当前环境', exact: true }).click();
  await expect.poll(() => connections[1]?.frames.length).toBe(1);
  respond(connections[1], connections[1].frames[0], '视频当前画面');
  await expect(caption(page)).toHaveText('视频当前画面');
  await page.locator('video').evaluate(async v => { const video = v as HTMLVideoElement; video.currentTime = video.duration - 0.2; await video.play(); });
  await expect(caption(page)).toHaveText('视频已结束');
  await expect(state(page)).toHaveText('实时连接：已断开');
});
