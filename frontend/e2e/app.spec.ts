import { test, expect, type Page } from '@playwright/test';

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByText('样例联调模式 · 不是实际识别')).toBeVisible();
  await page.getByRole('checkbox', { name: /我了解当前/ }).check();
}

test('sample mode, fake camera, read mode and release work against the real local API', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect(page.locator('.live-caption')).toHaveText('右侧发现楼梯');
  await expect(page.locator('.prediction-audit')).toBeVisible();
  await expect(page.locator('.prediction-audit')).toContainText(/预测|延迟/);
  await page.getByRole('button', { name: '看牌 · 读取文字' }).click();
  await expect(page.locator('.live-caption')).toContainText('标牌文字：样例牌');
  await page.getByRole('button', { name: '停止并释放输入' }).click();
  await expect(page.locator('.live-caption')).toHaveText('已停止，摄像头已释放');
  expect(await page.locator('video').evaluate(v => (v as HTMLVideoElement).srcObject)).toBeNull();
  expect(errors).toEqual([]);
});

test('a delayed old response never appears after switching input', async ({ page }) => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let seen!: () => void;
  const requested = new Promise<void>(resolve => { seen = resolve; });
  await page.route('**/api/analyze', async route => {
    const response = await route.fetch();
    seen(); await barrier;
    await route.fulfill({ response });
  });
  await ready(page);
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await requested;
  await page.getByRole('button', { name: '路线视频回放', exact: true }).click();
  release();
  await expect(page.locator('.live-caption')).toHaveText('输入已切换，请重新开始');
  await expect(page.locator('.event-list')).toBeEmpty();
  await expect(page.getByRole('button', { name: '重播上一条' })).toBeDisabled();
});

test('consecutive failures clear old results and pause automatic analysis', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect(page.locator('.live-caption')).toHaveText('右侧发现楼梯');
  let failures = 0;
  await page.route('**/api/analyze', async route => {
    failures++;
    await route.fulfill({ json: { status: 'error', message: '测试网络异常' } });
  });
  await expect(page.getByRole('alert')).toContainText('测试网络异常');
  await expect(page.locator('.event-list')).toBeEmpty();
  await expect(page.locator('.live-caption')).toHaveText('已暂停自动识别', { timeout: 10000 });
  expect(failures).toBe(3);
  await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeVisible();
});

test('transient busy and rate-limited rounds skip without tripping the pause', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T12:00:00Z') });
  await ready(page);
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect(page.locator('.live-caption')).toHaveText('右侧发现楼梯');
  let calls = 0;
  await page.route('**/api/analyze', async route => {
    calls++;
    if (calls <= 4)
      await route.fulfill({ status: 429, json: { status: 'error', error_code: 'busy', message: '上一帧仍在识别，请稍后再试。' } });
    else if (calls === 5)
      await route.fulfill({ status: 200, json: { status: 'error', error_code: 'rate_limited', message: '模型请求过于频繁，请稍后恢复。' } });
    else await route.fulfill({ response: await route.fetch() });
  });
  // Fake clock + strict single-flight: advance one tick at a time and let each
  // round's real network trip settle before the next tick, otherwise pending
  // tickets swallow every subsequent interval.
  for (let i = 0; i < 5; i++) {
    await page.clock.runFor(2000);
    await expect.poll(() => calls).toBeGreaterThan(i);
    await page.waitForTimeout(50);
  }
  // Four consecutive 429s would trip the three-failure pause; the walk loop must survive.
  await expect(page.locator('.live-caption')).toHaveText('右侧发现楼梯');
  await expect(page.locator('.event-list')).not.toBeEmpty();
  await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeHidden();
  await expect(page.getByRole('alert')).toContainText('模型请求过于频繁');
  // The cooldown parks the next send instead of immediately replaying a queued
  // frame. Fake-clock/network scheduling need not expose the exact internal
  // deadline, but analysis must resume after the complete cooldown window.
  const parked = calls;
  await page.clock.runFor(1000);
  expect(calls).toBe(parked);
  await page.clock.runFor(15000);
  await expect.poll(() => calls).toBeGreaterThan(parked);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.event-list')).not.toBeEmpty();
  await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeHidden();
});

test('pause aborts pending recognition and stops sampling', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect(page.locator('.live-caption')).toHaveText('右侧发现楼梯');
  await page.getByRole('button', { name: 'Ⅱ 暂停识别' }).click();
  let count = 0;
  page.on('request', request => { if (request.url().endsWith('/api/analyze')) count++; });
  await page.waitForTimeout(2200);
  expect(count).toBe(0);
  await expect(page.locator('.live-caption')).toHaveText('已暂停。按开始恢复识别');
});

test('video uploads frames, invalidates seeking, and restarts after ending', async ({ page }) => {
  await ready(page);
  // Synthetic test fixture only: this is not a route video or recognition evidence.
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const context = canvas.getContext('2d')!;
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4' });
    const chunks: Blob[] = [];
    const result = new Promise<number[]>(resolve => {
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())));
    });
    const timer = setInterval(() => { context.fillStyle = '#087a61'; context.fillRect(0, 0, 160, 90); context.fillStyle = 'white'; context.fillText(String(Date.now()), 10, 40); }, 80);
    recorder.start();
    await new Promise(resolve => setTimeout(resolve, 2000));
    recorder.stop(); clearInterval(timer); stream.getTracks().forEach(t => t.stop());
    return result;
  });
  await page.getByRole('button', { name: '路线视频回放', exact: true }).click();
  await page.getByLabel('选择 MP4 视频').setInputFiles({ name: 'synthetic.mp4', mimeType: 'video/mp4', buffer: Buffer.from(bytes) });
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole('checkbox', { name: '只用按键识别' }).check();
  const response = page.waitForResponse('**/api/analyze');
  await page.getByRole('button', { name: '识别当前环境', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.locator('.live-caption')).toHaveText('右侧发现楼梯');
  await page.locator('video').evaluate(v => { (v as HTMLVideoElement).currentTime = .5; });
  await expect(page.locator('.live-caption')).toContainText('视频位置已改变');
  await page.locator('video').evaluate(async v => { const video = v as HTMLVideoElement; video.currentTime = video.duration - .2; await video.play(); });
  await expect(page.locator('.live-caption')).toHaveText('视频已结束');
  await page.getByRole('button', { name: '识别当前环境', exact: true }).click();
  await expect(page.locator('.live-caption')).toHaveText('右侧发现楼梯');
});

test('mobile layout does not overflow and consent gates recognition', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByText('样例联调模式 · 不是实际识别')).toBeVisible();
  await expect(page.getByRole('button', { name: '▶ 开始识别' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});

test('desktop layout', async ({ page }) => {
  await ready(page);
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
});
