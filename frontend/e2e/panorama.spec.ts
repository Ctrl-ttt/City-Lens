import { test, expect, type Page } from '@playwright/test';

async function panoramaVideo(page: Page) {
  // Explicit synthetic geometry fixture, not actual camera/model evidence.
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 480;
    const context = canvas.getContext('2d')!;
    const draw = () => { context.fillStyle = '#0066cc'; context.fillRect(0, 0, 960, 480); context.fillStyle = '#22bb55'; context.fillRect(360, 0, 240, 480); };
    draw();
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4' });
    const chunks: Blob[] = [];
    const result = new Promise<number[]>(resolve => {
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())));
    });
    const timer = setInterval(draw, 80); recorder.start();
    await new Promise(resolve => setTimeout(resolve, 700));
    recorder.stop(); clearInterval(timer); stream.getTracks().forEach(t => t.stop());
    return result;
  });
  await page.getByRole('button', { name: '路线视频回放', exact: true }).click();
  await page.getByLabel('选择 MP4 视频').setInputFiles({ name: 'synthetic-panorama.mp4', mimeType: 'video/mp4', buffer: Buffer.from(bytes) });
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.getByLabel('画面格式').selectOption('equirectangular');
  await page.getByRole('checkbox', { name: '只用按键识别' }).check();
  await page.getByRole('checkbox', { name: /我了解当前/ }).check();
}

test('stitched panorama reaches actual local projection API and heading starts a new session', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await panoramaVideo(page);
  await page.evaluate(() => {
    const original = window.fetch;
    (window as unknown as { panoramaFields: Record<string, string>[] }).panoramaFields = [];
    window.fetch = (input, init) => {
      if (input === '/api/analyze' && init?.body instanceof FormData) {
        const fields: Record<string,string> = {};
        init.body.forEach((value, key) => { if (typeof value === 'string') fields[key] = value; });
        (window as unknown as { panoramaFields: Record<string,string>[] }).panoramaFields.push(fields);
      }
      return original(input, init);
    };
  });
  await page.getByRole('button', { name: '识别当前环境', exact: true }).click();
  await expect(page.locator('.live-caption')).toHaveText('前方发现楼梯');
  const form = await page.evaluate(() => (window as unknown as { panoramaFields: Record<string,string>[] }).panoramaFields[0]);
  expect(form.projection).toBe('equirectangular'); expect(form.heading_deg).toBe('0');
  await expect(page.locator('video')).toHaveCSS('transform', 'none');
  await page.getByLabel('正前方角度').focus();
  for (let i=0; i<6; i++) await page.getByLabel('正前方角度').press('ArrowRight');
  await expect(page.locator('.event-list')).toBeEmpty();
  await page.getByRole('button', { name: '识别当前环境', exact: true }).click();
  await expect(page.locator('.live-caption')).toHaveText('前方发现楼梯');
  const next = await page.evaluate(() => (window as unknown as { panoramaFields: Record<string,string>[] }).panoramaFields[1]);
  expect(next.heading_deg).toBe('90'); expect(next.session_id).not.toBe(form.session_id);
  await page.screenshot({ path: '../work/panorama-check/panorama-ui.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('changing panorama format invalidates a delayed previous result', async ({ page }) => {
  await page.goto('/'); await panoramaVideo(page);
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void; const seen = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/analyze', async route => {
    const response = await route.fetch(); arrived(); await barrier;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '识别当前环境', exact: true }).click(); await seen;
  await page.getByLabel('画面格式').selectOption('rectilinear'); release();
  await expect(page.locator('.event-list')).toBeEmpty();
  await expect(page.locator('.live-caption')).toHaveText('画面格式已切换，请确认正前方后重新开始');
});
