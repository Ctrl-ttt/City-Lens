import { test, expect, type Page } from '@playwright/test';

const device = { id: '6c696e6b32', name: 'Insta360 Link 2' };
const cameraState = { ptz: { pan: 0, tilt: 0 }, zoom: { min: 100, max: 400, step: 10, value: 100 }, autofocus: true };
const panel = (page: Page) => page.locator('.link2-panel');

async function camera(page: Page, labels = ['Insta360 Link 2 (2e1a:0001)']) {
  await page.addInitScript(labels => {
    const media = navigator.mediaDevices;
    const getUserMedia = media.getUserMedia.bind(media);
    media.enumerateDevices = async () => labels.map((label, index) => ({
      deviceId: `camera-${index}`, groupId: `group-${index}`, kind: 'videoinput', label, toJSON() { return {}; },
    } as MediaDeviceInfo));
    media.getUserMedia = async constraints => {
      const input = constraints?.video;
      const selected = typeof input === 'object' && typeof input.deviceId === 'object' && !Array.isArray(input.deviceId) ? input.deviceId.exact : 'camera-0';
      const index = Math.max(0, labels.findIndex((_, i) => `camera-${i}` === selected));
      const stream = await getUserMedia({ video: true, audio: false });
      Object.defineProperty(stream.getVideoTracks()[0], 'label', { value: labels[index] });
      return stream;
    };
  }, labels);
}

async function sdk(page: Page, options: {
  devices?: typeof device[];
  state?: typeof cameraState | { ptz: null; zoom: null; autofocus: null };
  error?: string;
  commandError?: string;
  commandWait?: Promise<void>;
  statusWait?: Promise<void>;
  listWait?: Promise<void>;
} = {}) {
  const commands: Record<string, unknown>[] = [];
  await page.route('**/api/camera/link2', async route => {
    expect(route.request().headers()['x-citylens-camera']).toBe('1');
    if (options.error) return route.fulfill({ status: 503, json: { status: 'error', message: options.error } });
    if (route.request().method() === 'GET') {
      await options.listWait;
      return route.fulfill({ json: { status: 'ready', devices: options.devices ?? [device] } });
    }
    const body = route.request().postDataJSON();
    commands.push(body);
    if (body.action === 'status') {
      await options.statusWait;
      return route.fulfill({ json: { status: 'ok', ...(options.state ?? cameraState) } });
    }
    await options.commandWait;
    return route.fulfill(options.commandError
      ? { status: 404, json: { status: 'error', message: options.commandError } }
      : { json: { status: 'ok', accepted: true } });
  });
  return commands;
}

async function preview(page: Page) {
  await page.goto('/');
  await page.getByText('Link 2 相机控制', { exact: true }).click();
  await page.getByRole('button', { name: '仅本地预览', exact: true }).click();
}

async function refresh(page: Page) {
  await panel(page).getByRole('button', { name: '刷新 Link 2 状态' }).click();
  await expect(panel(page).getByRole('button', { name: '应用云台角度' })).toBeEnabled();
}

test('local preview, PTZ, zoom and autofocus use the selected SDK device without cloud consent', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let analysisRequests = 0;
  page.on('request', request => { if (request.url().endsWith('/api/analyze')) analysisRequests++; });
  await camera(page);
  const commands = await sdk(page);
  await preview(page);
  await expect(panel(page).getByRole('button', { name: '应用云台角度' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeDisabled();
  await page.getByLabel('Link 2 水平角度').fill('20');
  await page.getByLabel('Link 2 俯仰角度').fill('-10');
  await panel(page).getByRole('button', { name: '应用云台角度' }).click();
  await expect(panel(page)).toContainText('指令已接收');
  await expect(panel(page).getByRole('button', { name: '应用云台角度' })).toHaveCount(0);
  await refresh(page);
  await page.getByLabel('Link 2 变焦').fill('150');
  await panel(page).getByRole('button', { name: '应用变焦' }).click();
  await expect(panel(page)).toContainText('指令已接收');
  await refresh(page);
  await panel(page).getByRole('button', { name: '关闭自动对焦' }).click();
  await expect(panel(page)).toContainText('指令已接收');
  expect(commands.filter(c => c.action !== 'status')).toEqual([
    { device_id: device.id, action: 'ptz', pan: 20, tilt: -10 },
    { device_id: device.id, action: 'zoom', zoom: 150 },
    { device_id: device.id, action: 'autofocus', enabled: false },
  ]);
  expect(analysisRequests).toBe(0);
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await refresh(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('pending control pauses recognition, clears guidance and blocks restarting until completion', async ({ page }) => {
  let release!: () => void;
  const commandWait = new Promise<void>(resolve => { release = resolve; });
  await camera(page);
  const commands = await sdk(page, { commandWait });
  await preview(page);
  await expect(panel(page).getByRole('button', { name: '云台回正' })).toBeEnabled();
  await page.getByRole('checkbox', { name: /我了解当前/ }).check();
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect(page.locator('.live-caption')).toHaveText('右侧发现楼梯');
  await panel(page).getByRole('button', { name: '云台回正' }).click();
  await expect.poll(() => commands.filter(c => c.action === 'ptz').length).toBe(1);
  await expect(page.locator('.event-list')).toBeEmpty();
  await expect(page.getByRole('button', { name: '重播上一条' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '看牌 · 读取文字' })).toBeDisabled();
  await expect(panel(page).getByRole('button', { name: '云台回正' })).toBeDisabled();
  release();
  await expect(panel(page)).toContainText('指令已接收');
  await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeEnabled();
  await expect(page.locator('.live-caption')).toContainText('识别已暂停');
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect(page.locator('.live-caption')).toHaveText('右侧发现楼梯');
});

test('SDK missing or disconnected does not break USB preview or sample recognition', async ({ page }) => {
  await camera(page);
  await sdk(page, { error: 'Link 2 控制组件尚未安装，请运行 scripts/setup-link2.ps1。USB 画面仍可使用。' });
  await preview(page);
  await expect(panel(page).getByRole('alert')).toContainText('控制组件尚未安装');
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole('checkbox', { name: /我了解当前/ }).check();
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect(page.locator('.live-caption')).toHaveText('右侧发现楼梯');
});

for (const variant of ['other-camera', 'multiple-browser', 'multiple-sdk', 'no-device'] as const) {
  test(`ambiguous or absent device never receives controls: ${variant}`, async ({ page }) => {
    await camera(page, variant === 'other-camera' ? ['Insta360 Link 2C'] : variant === 'multiple-browser' ? ['Insta360 Link 2', 'Insta360 Link 2'] : undefined);
    const commands = await sdk(page, { devices: variant === 'multiple-sdk' ? [device, { ...device, id: 'aabb' }] : variant === 'no-device' ? [] : undefined });
    await preview(page);
    await expect(panel(page).getByRole('button', { name: '刷新 Link 2 状态' })).toBeEnabled();
    await expect(panel(page).getByRole('button', { name: '应用云台角度' })).toHaveCount(0);
    if (variant.startsWith('multiple')) await expect(panel(page)).toContainText('检测到多台 Link 2');
    if (variant === 'no-device') await expect(panel(page)).toContainText('尚未检测到 Link 2');
    expect(commands).toEqual([]);
  });
}

test('late SDK status cannot enable controls after switching away from the camera', async ({ page }) => {
  let release!: () => void;
  const statusWait = new Promise<void>(resolve => { release = resolve; });
  await camera(page);
  const commands = await sdk(page, { statusWait });
  await preview(page);
  await expect.poll(() => commands.length).toBe(1);
  await page.getByRole('button', { name: '路线视频回放', exact: true }).click();
  release();
  await expect(panel(page)).toHaveCount(0);
  await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
  await page.getByText('Link 2 相机控制', { exact: true }).click();
  await expect(panel(page)).toContainText('先在摄像头列表中选择 Link 2');
  await expect(panel(page).getByRole('button', { name: '应用云台角度' })).toHaveCount(0);
  expect(commands).toHaveLength(1);
});

test('unsupported controls and invalid angles cannot send commands', async ({ page }) => {
  await camera(page);
  const commands = await sdk(page);
  await preview(page);
  const apply = panel(page).getByRole('button', { name: '应用云台角度' });
  await expect(apply).toBeEnabled();
  for (const value of ['146', '-146', '0.5', '']) {
    await page.getByLabel('Link 2 水平角度').fill(value);
    await expect(apply).toBeDisabled();
  }
  await page.getByLabel('Link 2 水平角度').fill('0');
  await page.getByLabel('Link 2 俯仰角度').fill('91');
  await expect(apply).toBeDisabled();
  expect(commands.filter(c => c.action !== 'status')).toEqual([]);
  await page.unroute('**/api/camera/link2');
  await sdk(page, { state: { ptz: null, zoom: null, autofocus: null } });
  await panel(page).getByRole('button', { name: '刷新 Link 2 状态' }).click();
  await expect(panel(page)).toContainText('当前设备未返回云台状态');
  await expect(apply).toBeDisabled();
  await expect(panel(page).getByRole('button', { name: '应用变焦' })).toBeDisabled();
  await expect(panel(page).getByRole('button', { name: '开启自动对焦' })).toBeDisabled();
});

test('device loss during a command displays an error, keeps recognition paused, and allows refresh', async ({ page }) => {
  await camera(page);
  await sdk(page, { commandError: '所选 Link 2 已断开，请刷新设备列表。' });
  await preview(page);
  await expect(panel(page).getByRole('button', { name: '云台回正' })).toBeEnabled();
  await panel(page).getByRole('button', { name: '云台回正' }).click();
  await expect(panel(page).getByRole('alert')).toContainText('已断开');
  await expect(page.locator('.live-caption')).toContainText('识别已暂停');
  await expect(panel(page).getByRole('button', { name: '应用云台角度' })).toHaveCount(0);
  await refresh(page);
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
});

test('SDK control closes realtime and ignores a delayed result from the old view', async ({ page }) => {
  await camera(page);
  await sdk(page);
  await page.route('**/api/health', route => route.fulfill({ json: { status: 'ok', provider: 'realtime', configured: true, model: 'test', http_configured: true, http_model: 'test', realtime_configured: true, realtime_model: 'test', sample_scene: null } }));
  let closed = false;
  let respond!: () => void;
  await page.routeWebSocket('**/api/realtime', socket => {
    socket.onClose(() => { closed = true; });
    socket.onMessage(message => {
      const { session_id, frame_id } = JSON.parse(String(message));
      respond = () => socket.send(JSON.stringify({ type: 'result', session_id, frame_id, status: 'ok', events: [], speech: { key: 'old', text: '旧画面不得播报', priority: 'normal' }, latency_ms: 1 }));
    });
    socket.send(JSON.stringify({ type: 'ready' }));
  });
  await preview(page);
  await expect(panel(page).getByRole('button', { name: '云台回正' })).toBeEnabled();
  await page.getByRole('checkbox', { name: /我了解抽帧/ }).check();
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect.poll(() => !!respond).toBe(true);
  await panel(page).getByRole('button', { name: '云台回正' }).click();
  await expect.poll(() => closed).toBe(true);
  respond();
  await expect(page.locator('.event-list')).toBeEmpty();
  await expect(page.locator('.live-caption')).toContainText('识别已暂停');
  await expect(page.getByRole('button', { name: '重播上一条' })).toBeDisabled();
});

test('automatic refreshes coalesce while discovery is still pending', async ({ page }) => {
  let release!: () => void;
  const listWait = new Promise<void>(resolve => { release = resolve; });
  let discoveries = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/camera/link2') && request.method() === 'GET') discoveries++;
  });
  await camera(page);
  const commands = await sdk(page, { listWait });
  await preview(page);
  await expect(page.getByText(/当前输入：Insta360 Link 2/)).toBeVisible();
  expect(discoveries).toBe(1);
  release();
  await expect(panel(page).getByRole('button', { name: '云台回正' })).toBeEnabled();
  expect(discoveries).toBe(2);
  expect(commands).toEqual([{ device_id: device.id, action: 'status' }]);
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
});

test('a late command from an unmounted panel cannot clear the next command busy state', async ({ page }) => {
  let releaseA!: () => void;
  let releaseB!: () => void;
  const commandA = new Promise<void>(resolve => { releaseA = resolve; });
  const commandB = new Promise<void>(resolve => { releaseB = resolve; });
  await camera(page);
  const options = { commandWait: commandA };
  const commands = await sdk(page, options);
  await preview(page);
  await page.getByRole('checkbox', { name: /我了解当前/ }).check();
  await panel(page).getByRole('button', { name: '云台回正' }).click();
  await expect.poll(() => commands.filter(c => c.action === 'ptz').length).toBe(1);
  await page.getByRole('button', { name: '路线视频回放', exact: true }).click();
  options.commandWait = commandB;
  await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
  await page.getByText('Link 2 相机控制', { exact: true }).click();
  await page.getByRole('button', { name: '仅本地预览', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: '云台回正' })).toBeEnabled();
  await panel(page).getByRole('button', { name: '云台回正' }).click();
  await expect.poll(() => commands.filter(c => c.action === 'ptz').length).toBe(2);
  const responseA = page.waitForResponse(response => response.url().endsWith('/api/camera/link2') && response.request().postDataJSON()?.action === 'ptz');
  releaseA();
  await (await responseA).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '看牌 · 读取文字' })).toBeDisabled();
  releaseB();
  await expect(panel(page)).toContainText('指令已接收');
  await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeEnabled();
});
