import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import type { Analysis, Health, RealtimeFrame } from '../src/types';

declare global {
  interface Window { __spoken: string[]; __cancelled: number; __captures: number }
}
const health: Health = { status: 'ok', provider: 'realtime', model: 'realtime-test', configured: true, sample_scene: null, http_model: 'http-test', http_configured: true, realtime_model: 'realtime-test', realtime_configured: true };
type Connection = { route: WebSocketRoute; frames: RealtimeFrame[]; closed: boolean };
function respond(connection: Connection, frame: Pick<RealtimeFrame, 'session_id' | 'frame_id'>, text = '右侧发现自行车') {
  connection.route.send(JSON.stringify({ type: 'result', ...analysis(frame, text) }));
}
function analysis(frame: Pick<RealtimeFrame, 'session_id' | 'frame_id'>, text: string) {
  return { session_id: frame.session_id, frame_id: frame.frame_id, status: 'ok', events: [{ category: 'obstacle', label: 'bicycle', direction: 'right', text }], speech: { key: text, priority: 'normal', text }, latency_ms: 100 };
}
function signAnalysis(frame: Pick<RealtimeFrame, 'session_id' | 'frame_id'>, text = '测试路', direction: Analysis['events'][number]['direction'] = 'front', clarity: 'high' | 'medium' = 'high'): Analysis {
  // Server fixtures use already-normalized text; direction/clarity never enter the speech key.
  const event = { category: 'text' as const, label: 'sign', direction, text, clarity };
  return { session_id: frame.session_id, frame_id: frame.frame_id, status: 'ok', events: [event], speech: { key: `sign:${text}`, priority: 'normal', text: `标牌文字：${text}` }, latency_ms: 100 };
}
async function setup(page: Page, options: { health?: Partial<Health>; ready?: boolean; results?: boolean; link2?: boolean; commandWait?: Promise<void> } = {}) {
  const connections: Connection[] = [];
  const http: { mode: string; source: string; closedBeforeHttp: boolean }[] = [];
  const commands: string[] = [];
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  // Only replace the OS speech engine. The real SpeechQueue, driver and Canvas run.
  await page.addInitScript(link2 => {
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
    if (link2) {
      // Relabel Playwright's fake camera; never access real Link2 hardware.
      const media = navigator.mediaDevices;
      const getUserMedia = media.getUserMedia.bind(media);
      media.enumerateDevices = async () => [{ deviceId: 'fake-link2', groupId: 'fake', kind: 'videoinput', label: 'Insta360 Link 2', toJSON() { return {}; } } as MediaDeviceInfo];
      media.getUserMedia = async () => {
        const input = await getUserMedia({ video: true, audio: false });
        Object.defineProperty(input.getVideoTracks()[0], 'label', { value: 'Insta360 Link 2' });
        return input;
      };
    }
  }, !!options.link2);
  await page.route('**/api/health', route => route.fulfill({ json: { ...health, ...options.health } }));
  // Keep Link2 discovery and controls local; no SDK or camera control service calls.
  await page.route('**/api/camera/link2', async route => {
    if (!options.link2) return route.fulfill({ json: { devices: [] } });
    if (route.request().method() === 'GET') return route.fulfill({ json: { status: 'ready', devices: [{ id: '6c696e6b32', name: 'Insta360 Link 2' }] } });
    const { action } = route.request().postDataJSON();
    if (action === 'status') return route.fulfill({ json: { status: 'ok', ptz: { pan: 0, tilt: 0 }, zoom: { min: 100, max: 400, step: 10, value: 100 }, autofocus: true } });
    commands.push(action);
    await options.commandWait;
    return route.fulfill({ json: { status: 'ok', accepted: true } });
  });
  await page.route('**/api/analyze', route => {
    const body = route.request().postDataBuffer()!.toString('latin1');
    const field = (name: string) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]+)`))?.[1] ?? '';
    http.push({ mode: field('mode'), source: field('source'), closedBeforeHttp: connections.every(c => c.closed) });
    const frame = { session_id: field('session_id'), frame_id: Number(field('frame_id')) };
    return route.fulfill({ json: field('mode') === 'read' ? signAnalysis(frame) : analysis(frame, 'HTTP 当前画面') });
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
  return { connections, http, commands, errors };
}
async function consentAndStart(page: Page) {
  await page.getByRole('checkbox', { name: /我了解抽帧/ }).check();
  await page.getByRole('button', { name: '▶ 开始识别', exact: true }).click();
}
const state = (page: Page) => page.getByRole('status', { name: '实时连接状态' });
const caption = (page: Page) => page.locator('.live-caption');

for (const source of ['camera', 'video'] as const) {
  test(`${source} preview and realtime/HTTP image pixels share the intended horizontal orientation`, async ({ page }, testInfo) => {
    const { connections, errors } = await setup(page);
    const bytes = await page.evaluate(async source => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d')!;
      const draw = () => {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.fillStyle = 'red'; context.fillRect(0, 0, 320, 360);
        context.fillStyle = 'blue'; context.fillRect(320, 0, 320, 360);
        if (source === 'camera') context.setTransform(-1, 0, 0, 1, 640, 0);
        context.fillStyle = 'white'; context.font = '32px sans-serif';
        context.fillText('CityLens 123', 40, 80);
      };
      draw();
      const stream = canvas.captureStream(10);
      const timer = setInterval(draw, 100);
      if (source === 'camera') {
        navigator.mediaDevices.getUserMedia = async constraints => {
          if (constraints?.audio !== false) throw new Error('Microphone must remain disabled');
          return stream;
        };
        return null;
      }
      const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4' });
      const chunks: Blob[] = [];
      const recorded = new Promise<number[]>(resolve => {
        recorder.ondataavailable = event => chunks.push(event.data);
        recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())));
      });
      recorder.start();
      await new Promise(resolve => setTimeout(resolve, 600));
      recorder.stop(); clearInterval(timer); stream.getTracks().forEach(track => track.stop());
      return recorded;
    }, source);
    if (source === 'video') {
      await page.getByRole('button', { name: '路线视频回放', exact: true }).click();
      await page.getByLabel('选择 MP4 视频').setInputFiles({ name: 'orientation.mp4', mimeType: 'video/mp4', buffer: Buffer.from(bytes!) });
      await expect.poll(() => page.locator('video').evaluate(video => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    }
    await page.getByRole('checkbox', { name: '只用按键识别' }).check();
    await page.getByRole('checkbox', { name: /我了解抽帧/ }).check();
    await page.getByRole('button', { name: '识别当前环境', exact: true }).click();
    await expect.poll(() => connections[0]?.frames.length).toBe(1);
    await expect(caption(page)).toHaveText('右侧发现自行车');
    await expect(page.locator('video')).toHaveCSS('transform', source === 'camera' ? 'matrix(-1, 0, 0, 1, 0, 0)' : 'none');

    const colors = (image: Buffer) => page.evaluate(async bytes => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
      return [.25, .75].map(x => {
        const [red, , blue] = context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height / 2), 1, 1).data;
        return red > 200 && blue < 40 ? 'red' : blue > 200 && red < 40 ? 'blue' : `unexpected(${red},${blue})`;
      });
    }, Array.from(image));
    const expected = source === 'camera' ? ['blue', 'red'] : ['red', 'blue'];
    expect(await colors(await page.locator('video').screenshot({ path: testInfo.outputPath('orientation.png') }))).toEqual(expected);
    expect(await colors(Buffer.from(connections[0].frames[0].image, 'base64'))).toEqual(expected);
    expect(connections[0].frames[0].source).toBe(source);

    for (const mode of ['read', 'walk']) {
      if (mode === 'walk') await page.getByRole('button', { name: 'HTTP 抽帧', exact: true }).click();
      const requested = page.waitForRequest('**/api/analyze');
      await page.getByRole('button', { name: mode === 'read' ? '看牌 · 读取文字' : '识别当前环境', exact: true }).click();
      const request = await requested;
      const form = await new Response(new Uint8Array(request.postDataBuffer()!), { headers: { 'Content-Type': request.headers()['content-type'] } }).formData();
      expect(form.get('mode')).toBe(mode);
      expect(form.get('source')).toBe(source);
      expect(await colors(Buffer.from(await (form.get('image') as File).arrayBuffer()))).toEqual(expected);
      await expect(caption(page)).toHaveText(mode === 'read' ? '标牌文字：测试路' : 'HTTP 当前画面');
    }
    await page.getByRole('button', { name: source === 'camera' ? '路线视频回放' : '实时摄像头', exact: true }).click();
    if (source === 'video') await page.getByRole('button', { name: '仅本地预览', exact: true }).click();
    await expect(page.locator('video')).toHaveCSS('transform', source === 'camera' ? 'none' : 'matrix(-1, 0, 0, 1, 0, 0)');
    expect(errors).toEqual([]);
  });
}

test.describe('continuous realtime frame stream', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date('2026-01-01T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-01T12:00:01Z'));
  });

  test('keeps capturing/sending at 1fps while results are withheld and accepts a selected frame after skipped frames', async ({ page }) => {
    const { connections, http, errors } = await setup(page, { results: false });
    await consentAndStart(page);
    await expect.poll(() => connections[0]?.frames.length).toBe(1);
    const connection = connections[0];
    await page.clock.runFor(3500);
    await expect.poll(() => connection.frames.length).toBe(4);
    expect(await page.evaluate(() => window.__captures)).toBe(4);
    expect(connection.frames.map(frame => frame.frame_id)).toEqual([1, 2, 3, 4]);
    expect(new Set(connection.frames.map(frame => frame.session_id)).size).toBe(1);
    expect(await page.evaluate(() => window.__spoken)).toEqual([]);
    await expect(page.locator('.event-list')).toBeEmpty();
    await expect(page.locator('.activity-label')).toHaveText('正在识别');
    await expect(page.locator('.quiet-note').filter({ hasText: '1 fps' })).toContainText('发送不等待分析');

    respond(connection, connection.frames[3], '最新画面发现入口');
    await expect(caption(page)).toHaveText('最新画面发现入口');
    await expect(page.locator('.event-list .event strong')).toHaveText(['最新画面发现入口']);
    await expect(page.locator('.debug-row')).toHaveCount(1);
    await expect(page.locator('.debug-row').first()).toContainText('#4 ·');
    expect(await page.evaluate(() => window.__spoken)).toEqual(['最新画面发现入口']);
    respond(connection, connection.frames[0], '旧结果不得覆盖');
    respond(connection, connection.frames[2], '倒序结果不得覆盖');
    respond(connection, { ...connection.frames[3], frame_id: 999 }, '未发送帧不得显示');
    await page.clock.runFor(100);
    await expect(caption(page)).toHaveText('最新画面发现入口');
    await expect(page.locator('.debug-row')).toHaveCount(1);
    expect(await page.evaluate(() => window.__spoken)).toEqual(['最新画面发现入口']);
    await page.clock.runFor(1000);
    await expect.poll(() => connection.frames.length).toBe(5);
    expect(await page.evaluate(() => window.__captures)).toBe(5);
    expect(http).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  test('does not lose a whole send slot when readiness lands between timer ticks', async ({ page }) => {
    const { connections, errors } = await setup(page, { ready: false, results: false });
    await consentAndStart(page);
    await expect.poll(() => connections.length).toBe(1);
    await page.clock.runFor(250);
    connections[0].route.send('{"type":"ready"}');
    await expect.poll(() => connections[0].frames.length).toBe(1);
    await page.clock.runFor(1100);
    await expect.poll(() => connections[0].frames.length).toBe(2);
    await page.clock.runFor(1000);
    await expect.poll(() => connections[0].frames.length).toBe(3);
    expect(await page.evaluate(() => window.__captures)).toBe(3);
    expect(errors).toEqual([]);
  });

  for (const action of ['pause', 'source', 'sdk'] as const) {
    test(`${action} fences every outstanding frame and restarts with only new-session results`, async ({ page }) => {
      let release!: () => void;
      const commandWait = new Promise<void>(resolve => { release = resolve; });
      const { connections, commands, errors } = await setup(page, { results: false, link2: action === 'sdk', commandWait });
      await consentAndStart(page);
      await expect.poll(() => connections[0]?.frames.length).toBe(1);
      if (action === 'sdk') {
        await page.getByText('Link 2 相机控制', { exact: true }).click();
        await expect(page.getByRole('button', { name: '云台回正' })).toBeEnabled();
      }
      await page.clock.runFor(3500);
      await expect.poll(() => connections[0].frames.length).toBe(4);
      const old = connections[0].frames[3];
      if (action === 'pause') await page.getByRole('button', { name: 'Ⅱ 暂停识别' }).click();
      if (action === 'source') await page.getByRole('button', { name: '路线视频回放', exact: true }).click();
      if (action === 'sdk') {
        await page.getByRole('button', { name: '云台回正' }).click();
        await expect.poll(() => commands.length).toBe(1);
        await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeDisabled();
        await expect(page.getByRole('button', { name: '看牌 · 读取文字' })).toBeDisabled();
      }
      await expect.poll(() => connections[0].closed).toBe(true);
      const pausedNotice = await caption(page).textContent();
      respond(connections[0], old, '旧会话不得显示或播报');
      await page.clock.runFor(3000);
      expect(connections[0].frames).toHaveLength(4);
      expect(await page.evaluate(() => window.__captures)).toBe(4);
      await expect(caption(page)).toHaveText(pausedNotice!);
      await expect(page.locator('.event-list')).toBeEmpty();
      await expect(page.getByRole('button', { name: '重播上一条' })).toBeDisabled();
      expect(await page.evaluate(() => window.__spoken)).toEqual([]);
      release();
      if (action === 'sdk') await expect(page.locator('.link2-panel')).toContainText('指令已接收');
      if (action === 'source') await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
      await page.getByRole('button', { name: '▶ 开始识别' }).click();
      await expect.poll(() => connections[1]?.frames.length).toBe(1);
      const fresh = connections[1].frames[0];
      expect(fresh.session_id).not.toBe(old.session_id);
      expect(fresh.frame_id).toBe(1);
      // Even an old-session result on the new socket must not be accepted.
      respond(connections[1], old, '跨会话结果不得显示');
      respond(connections[1], { ...fresh, frame_id: 999 }, '未发送结果不得显示');
      await page.clock.runFor(100);
      await expect(page.locator('.event-list')).toBeEmpty();
      expect(await page.evaluate(() => window.__spoken)).toEqual([]);
      respond(connections[1], fresh, '恢复后的当前画面');
      await expect(caption(page)).toHaveText('恢复后的当前画面');
      expect(await page.evaluate(() => window.__spoken)).toEqual(['恢复后的当前画面']);
      expect(errors).toEqual([]);
    });
  }
});

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
  await expect(caption(page)).toHaveText('右侧发现自行车');
  await expect(state(page)).toHaveText('实时连接：已连接');
  expect(await page.evaluate(() => window.__spoken)).toEqual(['右侧发现自行车']);
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
  await expect(caption(page)).toHaveText('右侧发现自行车');
  expect(connections[1].frames[0].session_id).not.toBe(frame.session_id);
  expect(errors).toEqual([]);
});

test('live default allows realtime and switching channels stops without automatic restart', async ({ page }) => {
  const { connections, http } = await setup(page, { health: { provider: 'live', model: 'http-test' } });
  await expect(page.getByRole('button', { name: 'HTTP 抽帧', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '实时连接', exact: true }).click();
  await consentAndStart(page);
  await expect(caption(page)).toHaveText('右侧发现自行车');
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
  await expect(caption(page)).toHaveText('右侧发现自行车');
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

test.describe('automatic road sign OCR', () => {
  test.beforeEach(async ({ page }) => {
    // The configured browser supplies a fake camera; only explicit clock steps capture more frames.
    await page.clock.install({ time: new Date('2026-01-01T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-01T12:00:01Z'));
  });

  async function nextFrame(page: Page, connection: Connection) {
    const index = connection.frames.length;
    await page.clock.runFor(1000);
    await expect.poll(() => connection.frames.length).toBe(index + 1);
    return connection.frames[index];
  }
  async function showResult(page: Page, connection: Connection, result: Analysis) {
    // Wait for the committed result, not a one-send/one-result busy transition.
    connection.route.send(JSON.stringify({ type: 'result', ...result }));
    await expect(page.locator('.debug-row').first()).toContainText(`#${result.frame_id} ·`);
  }

  test('walk displays and speaks signs without manual reading, deduplicating direction/clarity changes by content', async ({ page }) => {
    const { connections, http, errors } = await setup(page, { results: false });
    await consentAndStart(page);
    await expect.poll(() => connections[0]?.frames.length).toBe(1);
    const connection = connections[0];
    await showResult(page, connection, signAnalysis(connection.frames[0], '中山路 入口'));
    await expect(caption(page)).toHaveText('标牌文字：中山路 入口');
    await expect(page.locator('.event-list .event strong')).toHaveText(['中山路 入口']);
    await expect(page.locator('.event-list .event-dot.text')).toHaveCount(1);
    await expect(page.locator('.mode-label')).toHaveText('环境提示');
    await expect(page.getByRole('button', { name: 'Ⅱ 暂停识别' })).toBeVisible();
    expect(await page.evaluate(() => window.__spoken)).toEqual(['标牌文字：中山路 入口']);
    expect(http).toHaveLength(0);

    // Change direction alone, then clarity alone, without changing the server's normalized key.
    for (const clarity of ['high', 'medium'] as const) {
      const frame = await nextFrame(page, connection);
      await showResult(page, connection, signAnalysis(frame, '中山路 入口', 'left', clarity));
      await expect(page.locator('.event-list .event')).toContainText('左侧');
      await expect(caption(page)).toHaveText('标牌文字：中山路 入口');
      expect(await page.evaluate(() => window.__spoken)).toEqual(['标牌文字：中山路 入口']);
    }
    const changed = await nextFrame(page, connection);
    await showResult(page, connection, signAnalysis(changed, '测试路', 'right', 'medium'));
    await expect(caption(page)).toHaveText('标牌文字：测试路');
    await expect(page.locator('.event-list .event strong')).toHaveText(['测试路']);
    expect(await page.evaluate(() => window.__spoken)).toEqual(['标牌文字：中山路 入口', '标牌文字：测试路']);
    expect(connection.frames.every(frame => frame.mode === 'walk' && frame.source === 'camera')).toBe(true);
    expect(connections).toHaveLength(1);
    expect(http).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  test('a high obstacle interrupts a sign that is still speaking', async ({ page }) => {
    const { connections, http, errors } = await setup(page, { results: false });
    await page.evaluate(() => {
      // Withhold onend so the real queue must interrupt active normal-priority speech.
      window.speechSynthesis.speak = utterance => { window.__spoken.push(utterance.text); };
    });
    await consentAndStart(page);
    await expect.poll(() => connections[0]?.frames.length).toBe(1);
    const connection = connections[0];
    await showResult(page, connection, signAnalysis(connection.frames[0]));
    expect(await page.evaluate(() => window.__spoken)).toEqual(['标牌文字：测试路']);
    const cancels = await page.evaluate(() => window.__cancelled);
    const frame = await nextFrame(page, connection);
    await showResult(page, connection, {
      session_id: frame.session_id, frame_id: frame.frame_id, status: 'ok', latency_ms: 100,
      // The server orders obstacles before signs before facilities and selects the obstacle speech.
      events: [
        { category: 'obstacle', label: 'stairs', direction: 'front', text: '前方发现台阶' },
        ...signAnalysis(frame).events,
        { category: 'facility', label: 'entrance', direction: 'right', text: '右侧发现入口' },
      ],
      speech: { key: 'obstacle:stairs:front', priority: 'high', text: '前方发现台阶' },
    });
    await expect(caption(page)).toHaveText('前方发现台阶');
    await expect(page.locator('.event-list .event strong')).toHaveText(['前方发现台阶', '测试路', '右侧发现入口']);
    expect(await page.evaluate(() => window.__cancelled)).toBe(cancels + 1);
    expect(await page.evaluate(() => window.__spoken)).toEqual(['标牌文字：测试路', '前方发现台阶']);
    expect(http).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  for (const scenario of [
    { name: 'low-clarity sign', status: 'ok', notice: '本帧没有可确认的提示；不代表通行安全' },
    { name: 'unreadable frame', status: 'uncertain', notice: '画面不清晰，请调整拍摄角度' },
  ] as const) {
    test(`${scenario.name} does not speak and removes the previous sign from replay`, async ({ page }) => {
      const { connections, http, errors } = await setup(page, { results: false });
      await consentAndStart(page);
      await expect.poll(() => connections[0]?.frames.length).toBe(1);
      const connection = connections[0];
      await showResult(page, connection, signAnalysis(connection.frames[0]));
      await expect(page.getByRole('button', { name: '重播上一条' })).toBeEnabled();
      expect(await page.evaluate(() => window.__spoken)).toEqual(['标牌文字：测试路']);
      const frame = await nextFrame(page, connection);
      // Filtering is a backend responsibility: low/unreadable OCR never reaches the UI as a sign.
      await showResult(page, connection, {
        session_id: frame.session_id, frame_id: frame.frame_id, status: scenario.status,
        events: [], speech: null, latency_ms: 100,
      });
      await expect(caption(page)).toHaveText(scenario.notice);
      await expect(page.locator('.event-list')).toBeEmpty();
      await expect(page.getByRole('button', { name: '重播上一条' })).toBeDisabled();
      await expect(page.locator('.mode-label')).toHaveText('环境提示');
      expect(await page.evaluate(() => window.__spoken)).toEqual(['标牌文字：测试路']);
      expect(http).toHaveLength(0);
      expect(errors).toEqual([]);
    });
  }

  test('manual read repeats an automatic sign over HTTP and returns to realtime environment recognition', async ({ page }) => {
    const { connections, http, errors } = await setup(page, { results: false });
    await consentAndStart(page);
    await expect.poll(() => connections[0]?.frames.length).toBe(1);
    const old = connections[0].frames[0];
    await showResult(page, connections[0], signAnalysis(old));
    expect(await page.evaluate(() => window.__spoken)).toEqual(['标牌文字：测试路']);
    expect(http).toHaveLength(0);

    await page.getByRole('button', { name: '看牌 · 读取文字' }).click();
    await expect(caption(page)).toHaveText('标牌文字：测试路');
    await expect(page.locator('.mode-label')).toHaveText('看牌模式');
    await expect(page.locator('.event-list .event strong')).toHaveText(['测试路']);
    await expect.poll(() => connections[0].closed).toBe(true);
    await expect(state(page)).toHaveText('实时连接：已断开');
    expect(http).toEqual([{ mode: 'read', source: 'camera', closedBeforeHttp: true }]);
    expect(await page.evaluate(() => window.__spoken)).toEqual(['标牌文字：测试路', '标牌文字：测试路']);
    await page.clock.runFor(5000);
    expect(connections).toHaveLength(1);
    expect(connections[0].frames).toHaveLength(1);
    expect(http).toHaveLength(1);

    await page.getByRole('button', { name: '▶ 返回环境识别' }).click();
    await expect.poll(() => connections[1]?.frames.length).toBe(1);
    const resumed = connections[1].frames[0];
    expect(resumed).toMatchObject({ mode: 'walk', source: 'camera' });
    expect(resumed.session_id).not.toBe(old.session_id);
    await showResult(page, connections[1], signAnalysis(resumed, '中山路'));
    await expect(caption(page)).toHaveText('标牌文字：中山路');
    await expect(page.locator('.mode-label')).toHaveText('环境提示');
    await expect(state(page)).toHaveText('实时连接：已连接');
    expect(await page.evaluate(() => window.__spoken)).toEqual(['标牌文字：测试路', '标牌文字：测试路', '标牌文字：中山路']);
    expect(http).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});

test('single-frame keypress sends once while awaiting analysis and closes after the result', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T12:00:01Z'));
  const { connections } = await setup(page, { results: false });
  await page.getByRole('checkbox', { name: /我了解抽帧/ }).check();
  await page.getByRole('checkbox', { name: '只用按键识别' }).check();
  await page.getByRole('button', { name: '识别当前环境', exact: true }).click();
  await expect.poll(() => connections[0]?.frames.length).toBe(1);
  await page.clock.runFor(3500);
  expect(connections[0].frames).toHaveLength(1);
  expect(await page.evaluate(() => window.__captures)).toBe(1);
  respond(connections[0], connections[0].frames[0]);
  await expect(caption(page)).toHaveText('右侧发现自行车');
  await expect.poll(() => connections[0].closed).toBe(true);
  await expect(state(page)).toHaveText('实时连接：已断开');
  await page.clock.runFor(10000);
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
  await expect(caption(page)).toHaveText('右侧发现自行车');
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
  expect(await page.evaluate(() => window.__spoken)).toEqual(['右侧发现自行车']);
  expect(await page.evaluate(() => window.__cancelled)).toBeGreaterThan(cancels);
  await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeVisible();
});

test('progress watchdog expires despite continuous sends; stale walk results never display or speak', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T12:00:01Z'));
  const { connections } = await setup(page, { results: false });
  await consentAndStart(page);
  await expect.poll(() => connections[0]?.frames.length).toBe(1);
  await page.clock.runFor(6100);
  await expect.poll(() => connections[0].frames.length).toBe(7);
  respond(connections[0], connections[0].frames[0], '过期画面');
  await expect(page.getByRole('alert')).toContainText('结果已过期');
  await expect(page.locator('.event-list')).toBeEmpty();
  await expect(page.getByRole('button', { name: '重播上一条' })).toBeDisabled();
  expect(await page.evaluate(() => window.__spoken)).toEqual([]);
  // Valid transport progress renews the deadline even if too old for UI/TTS.
  await page.clock.runFor(8999);
  await expect(state(page)).toHaveText('实时连接：已连接');
  await expect.poll(() => connections[0].frames.length).toBe(16);
  await page.clock.runFor(1);
  await expect(state(page)).toHaveText('实时连接：恢复中');
  await expect.poll(() => connections[0].closed).toBe(true);
  await page.clock.runFor(1000);
  await expect.poll(() => connections[1]?.frames.length).toBe(1);
  expect(connections[1].frames[0].session_id).not.toBe(connections[0].frames[0].session_id);
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
