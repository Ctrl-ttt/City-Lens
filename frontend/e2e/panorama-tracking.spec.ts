import { test, expect, type Page, type Route } from '@playwright/test';

type DiagnosticsState = { workers: number; frames: number; terminated: number; spoken: string[]; occluded: boolean; moving: boolean };
const pendingRoutes = new WeakMap<Page, Set<Promise<void>>>();

async function setup(page: Page) {
  const errors: string[] = [];
  const pending = new Set<Promise<void>>();
  pendingRoutes.set(page, pending);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const state = { workers: 0, frames: 0, terminated: 0, spoken: [] as string[], occluded: false, moving: true };
    Object.assign(window, { diagnosticsTest: state });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); state.workers++; }
      postMessage(message: { type: string }, transfer?: Transferable[] | StructuredSerializeOptions) {
        if (message.type === 'frame') state.frames++;
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
      terminate() { state.terminated++; super.terminate(); }
    } as typeof Worker;
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(public text: string) {} } });
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [{ name: '测试中文语音', lang: 'zh-CN', localService: true }],
      addEventListener() {}, removeEventListener() {}, cancel() {},
      speak(utterance: SpeechSynthesisUtterance) { state.spoken.push(utterance.text); queueMicrotask(() => utterance.onend?.call(utterance, {} as SpeechSynthesisEvent)); },
    } });
    navigator.mediaDevices.getUserMedia = async () => {
      // Synthetic textured motion only; this is not camera or model accuracy evidence.
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 320;
      const context = canvas.getContext('2d')!;
      const background = document.createElement('canvas'); background.width = 320; background.height = 160;
      const bg = background.getContext('2d')!;
      let seed = 42;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; };
      const pixels = bg.createImageData(320, 160);
      for (let i = 0; i < pixels.data.length; i += 4) { const value = random(); pixels.data.set([value, value, value, 255], i); }
      bg.putImageData(pixels, 0, 0);
      const target = document.createElement('canvas'); target.width = 56; target.height = 60;
      const tc = target.getContext('2d')!;
      const texture = tc.createImageData(56, 60);
      for (let i = 0; i < texture.data.length; i += 4) { const value = random(); texture.data.set([value, value, value, 255], i); }
      tc.putImageData(texture, 0, 0);
      let tick = 0;
      const draw = () => {
        context.imageSmoothingEnabled = false;
        context.drawImage(background, 0, 0, 640, 320);
        if (!state.occluded) context.drawImage(target, 264 + (state.moving ? Math.min(32, Math.floor(tick / 3)) * 2 : 0), 100, 112, 120);
        tick++;
      };
      draw(); setInterval(draw, 50);
      return canvas.captureStream(20);
    };
  });
  const intercept = async (route: Route) => {
    const responseTask = (async () => {
      const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'http://localhost:8000' } });
      const data = await response.json();
      expect(response.ok(), data.message).toBe(true);
      if (route.request().url().endsWith('/api/read')) { await route.fulfill({ response }); return; }
      await new Promise(resolve => setTimeout(resolve, 800));
      await route.fulfill({ json: { ...data, status: 'ok', events: [{ category: 'obstacle', label: 'bicycle', text: '自行车', direction: 'front', view: 'front', box: [300, 300, 700, 700] }], speech: { text: '前方发现自行车', key: 'tracking-test', priority: 'normal' } } });
    })();
    pending.add(responseTask);
    try { await responseTask; } finally { pending.delete(responseTask); }
  };
  await page.route('**/api/walk', intercept);
  await page.route('**/api/read', intercept);
  await page.goto('/');
  await expect(page.getByText('样例联调模式 · 不是实际识别')).toBeVisible();
  await page.getByLabel('画面格式').selectOption('equirectangular');
  return errors;
}

async function state(page: Page) { return page.evaluate(() => (window as unknown as { diagnosticsTest: DiagnosticsState }).diagnosticsTest); }
async function start(page: Page) {
  await page.getByRole('checkbox', { name: /我了解当前/ }).check();
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
}

test.afterEach(async ({ page }) => {
  await page.getByRole('button', { name: '停止并释放输入' }).click();
  // Removing interception can continue a route before its delayed fulfill completes.
  await Promise.all(pendingRoutes.get(page) ?? []);
  await page.unrouteAll({ behavior: 'wait' });
});

test('opt-in tracking replays actual local frames, overlays current positions and leaves speech unchanged', async ({ page }) => {
  const errors = await setup(page);
  const panel = page.getByRole('region', { name: '全景跟踪验证' });
  await expect(page.getByLabel('启用本地跟踪验证（不影响播报）')).not.toBeChecked();
  await page.getByLabel('启用本地跟踪验证（不影响播报）').check();
  expect((await state(page)).workers).toBe(0);
  await start(page);
  await expect(panel.locator('.tracking-list')).toContainText('连续匹配', { timeout: 15000 });
  await expect(page.locator('.tracking-current').first()).toBeVisible();
  await expect(page.locator('.tracking-label-current')).toHaveText('1. 自行车 · 跟踪');
  await expect(page.locator('.tracking-label-original')).toHaveText('1. 自行车 · 识别时');
  await expect.poll(async () => (await page.locator('.tracking-current').first().getAttribute('d')) !== (await page.locator('.tracking-original').first().getAttribute('d'))).toBe(true);
  await expect(page.locator('.live-caption')).toHaveText('前方发现自行车');
  expect((await state(page)).spoken).toEqual(['前方发现自行车']);
  expect((await state(page)).frames).toBeGreaterThan(3);
  await expect(panel).toContainText('不影响播报');
  await page.screenshot({ path: '../work/panorama-check/tracking-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => page.locator('.tracking-label-original text').evaluate(text => {
    const transform = (text as SVGTextElement).getScreenCTM()!;
    return parseFloat(getComputedStyle(text).fontSize) * Math.hypot(transform.a, transform.b);
  })).toBeCloseTo(14, 1);
  expect(await page.locator('.tracking-label').evaluateAll(labels => labels.every(label => {
    const svg = label.closest('svg')!.getBoundingClientRect();
    const rect = label.querySelector('rect')!.getBoundingClientRect();
    const text = label.querySelector('text')!.getBoundingClientRect();
    return rect.left >= svg.left && rect.right <= svg.right && rect.top >= svg.top && rect.bottom <= svg.bottom
      && text.left >= rect.left && text.right <= rect.right && text.top >= rect.top && text.bottom <= rect.bottom;
  }))).toBe(true);
  await page.screenshot({ path: '../work/panorama-check/tracking-mobile.png', fullPage: true });
  await page.getByLabel('启用本地跟踪验证（不影响播报）').uncheck();
  await expect(page.locator('.panorama-overlay')).toHaveCount(0);
  const stopped = await state(page);
  await page.waitForTimeout(400);
  expect((await state(page)).frames).toBe(stopped.frames);
  expect(stopped.terminated).toBe(1);
  await expect(page.locator('.live-caption')).toHaveText('前方发现自行车');
  expect(errors).toEqual([]);
});

test('occlusion removes current markers without cancelling the original speech', async ({ page }) => {
  await setup(page);
  await page.getByLabel('启用本地跟踪验证（不影响播报）').check();
  await start(page);
  await expect(page.locator('.tracking-list')).toContainText('连续匹配', { timeout: 15000 });
  await page.evaluate(() => { (window as unknown as { diagnosticsTest: DiagnosticsState }).diagnosticsTest.occluded = true; });
  await expect(page.locator('.tracking-list')).toContainText('跟踪失效');
  await expect(page.locator('.tracking-current')).toHaveCount(0);
  await expect(page.locator('.tracking-label-current')).toHaveCount(0);
  await expect(page.locator('.tracking-label-original')).toHaveText('1. 自行车 · 识别时');
  await expect(page.locator('.live-caption')).toHaveText('前方发现自行车');
  expect((await state(page)).spoken).toEqual(['前方发现自行车']);
});

test('pause, heading changes, read turns and format changes clear diagnostic history', async ({ page }) => {
  await setup(page);
  await page.getByLabel('启用本地跟踪验证（不影响播报）').check();
  await start(page);
  await expect(page.locator('.tracking-list')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Ⅱ 暂停识别' }).click();
  await expect(page.locator('.panorama-overlay')).toHaveCount(0);
  let count = (await state(page)).frames;
  await page.waitForTimeout(400); expect((await state(page)).frames).toBe(count);
  // Browser cancellation does not cancel route.fetch's separate backend request.
  await Promise.all(pendingRoutes.get(page) ?? []);
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect(page.locator('.tracking-list')).not.toBeEmpty();
  await page.getByLabel('正前方角度').focus(); await page.getByLabel('正前方角度').press('ArrowRight');
  await expect(page.locator('.panorama-overlay')).toHaveCount(0);
  expect(await page.locator('video').evaluate(video => (video as HTMLVideoElement).paused)).toBe(false);
  await Promise.all(pendingRoutes.get(page) ?? []);
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect(page.locator('.tracking-list')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Ⅱ 暂停识别' }).click();
  await Promise.all(pendingRoutes.get(page) ?? []);
  count = (await state(page)).workers;
  const readResponse = page.waitForResponse(response => response.url().endsWith('/api/read'));
  await page.getByRole('button', { name: '看牌 · 读取文字' }).click();
  expect((await readResponse).ok()).toBe(true);
  await expect(page.locator('.activity-label')).toHaveText('等待操作');
  await expect(page.locator('.panorama-overlay')).toHaveCount(0);
  expect((await state(page)).workers).toBe(count);
  await page.getByLabel('画面格式').selectOption('rectilinear');
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect(page.getByRole('region', { name: '全景跟踪验证' })).toHaveCount(0);
  expect((await state(page)).workers).toBe(count);
});

test('disabling tracking fences an outstanding response without dropping normal recognition', async ({ page }) => {
  await setup(page);
  await page.getByLabel('启用本地跟踪验证（不影响播报）').check();
  const requested = page.waitForRequest('**/api/walk');
  await start(page); await requested;
  await page.getByLabel('启用本地跟踪验证（不影响播报）').uncheck();
  await expect(page.locator('.live-caption')).toHaveText('前方发现自行车');
  await expect(page.locator('.panorama-overlay')).toHaveCount(0);
  expect((await state(page)).terminated).toBe(1);
});
