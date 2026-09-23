import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let directory: string, videoBytes: Buffer, sidecar: Record<string, unknown>;
// Edge needs graphics decoding for the real HEVC exports.
test.use({ launchOptions: { args: [] } });

test.beforeAll(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'citylens-imu-'));
  const videoPath = path.join(directory, 'synthetic.mp4');
  execFileSync(path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), ['-c', `
import av, numpy as np, sys
x,y=np.meshgrid(np.arange(320),np.arange(160))
base=np.rint(128+50*np.sin(x*np.pi/20)+30*np.cos(y*np.pi/16)).astype(np.uint8)
with av.open(sys.argv[1],'w') as output:
 stream=output.add_stream('libx264',rate=25)
 stream.width=320;stream.height=160;stream.pix_fmt='yuv420p'
 for i in range(200):
  frame=av.VideoFrame.from_ndarray(np.roll(base,i,axis=1),format='gray')
  for packet in stream.encode(frame):output.mux(packet)
 for packet in stream.encode():output.mux(packet)
`, videoPath], { timeout: 60000 });
  videoBytes = readFileSync(videoPath);
  const fingerprint = createHash('sha256').update(String(videoBytes.length)).update(videoBytes.subarray(0, 65536))
    .update(videoBytes.subarray(Math.max(0, videoBytes.length - 65536))).digest('hex');
  sidecar = { version: 1, camera: 'synthetic-test-not-real-camera',
    video: { name: 'synthetic.mp4', size: videoBytes.length, fingerprint, duration: 8 },
    calibration: { accepted: true, improvement: 0.5, baseline_error: 10, compensated_error: 5, pairs: 12 },
    samples: Array.from({ length: 801 }, (_, i) => {
      const time = i / 100, angle = time * 25 / 320 * 2 * Math.PI;
      return [time, 0, Math.sin(angle / 2), 0, Math.cos(angle / 2), 28.125, 1];
    }) };
});
test.afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

async function setup(page: Page) {
  const calls: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/health', route => route.fulfill({ json: { status: 'ok', provider: 'sample', configured: true,
    model: 'fixed-sample', http_model: 'fixed-sample', read_model: 'fixed-sample', http_configured: true,
    realtime_model: '', realtime_configured: false, sample_scene: 'bicycle' } }));
  await page.route(/\/api\/(walk|read|realtime)(\?|$)/, route => { calls.push(route.request().url()); return route.abort(); });
  await page.goto('/');
  await expect(page.getByText('样例联调模式 · 不是实际识别')).toBeVisible();
  await page.getByRole('button', { name: '路线视频回放' }).click();
  await page.getByLabel('画面格式', { exact: true }).selectOption('equirectangular');
  await page.getByLabel('选择 MP4 视频').setInputFiles({ name: 'synthetic.mp4', mimeType: 'video/mp4', buffer: videoBytes });
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  return { panel: page.getByRole('region', { name: 'IMU旋转补偿验证' }), calls, errors };
}

async function load(page: Page, value = sidecar) {
  await page.getByLabel('选择 IMU 数据').setInputFiles({ name: 'imu.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
}
async function play(page: Page) { await page.locator('video').evaluate(v => (v as HTMLVideoElement).play()); }

test('local IMU playback requires opt-in and compares real decoded frames without cloud requests', async ({ page }) => {
  const { panel, calls, errors } = await setup(page);
  await load(page);
  await expect(panel).toContainText('已匹配当前视频指纹');
  await expect(page.getByLabel('启用本地 IMU 对照（不上传）')).not.toBeChecked();
  await play(page);
  await expect(panel).not.toContainText('相机角速度');
  await page.getByLabel('启用本地 IMU 对照（不上传）').check();
  await expect(panel).toContainText('本地连续帧光度误差对照中');
  await expect(panel).toContainText('相机角速度 28.13');
  await expect(panel).toContainText('加速度模长 1.000');
  expect(calls).toEqual([]);
  await page.locator('video').evaluate(v => (v as HTMLVideoElement).pause());
  await expect(panel).toContainText('视频已暂停，已清空帧对照');
  await expect(panel).not.toContainText('相机角速度');
  await page.locator('video').evaluate(v => { (v as HTMLVideoElement).currentTime = 1; });
  await play(page);
  await expect(panel).toContainText('本地连续帧光度误差对照中');
  await page.getByLabel('启用本地 IMU 对照（不上传）').uncheck();
  await expect(panel).not.toContainText('相机角速度');
  expect(calls).toEqual([]); expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('invalid or mismatched sidecars clear old data; changing video never reuses the previous IMU', async ({ page }) => {
  const { panel, calls, errors } = await setup(page);
  await load(page); await expect(panel).toContainText('已匹配当前视频指纹');
  await load(page, { ...sidecar, video: { ...(sidecar.video as object), fingerprint: '0'.repeat(64) } });
  await expect(panel).toContainText('视频指纹不匹配');
  await expect(panel).not.toContainText('数据文件：');
  await load(page, {}); await expect(panel).toContainText('IMU 数据格式无效');
  await load(page); await expect(panel).toContainText('已匹配当前视频指纹');
  await page.getByLabel('选择 MP4 视频').setInputFiles({ name: 'changed.mp4', mimeType: 'video/mp4', buffer: videoBytes });
  await expect(panel).toContainText('视频已切换，请重新选择');
  await expect(panel).not.toContainText('数据文件：');
  expect(calls).toEqual([]); expect(errors).toEqual([]);
});

test('failed calibration only shows sensors, and hiding the page clears observations', async ({ page }) => {
  const { panel, calls, errors } = await setup(page);
  await load(page, { ...sidecar, calibration: { ...(sidecar.calibration as object), accepted: false } });
  await expect(panel).toContainText('已匹配当前视频指纹');
  await page.getByLabel('启用本地 IMU 对照（不上传）').check(); await play(page);
  await expect(panel).toContainText('相机角速度');
  await expect(panel).toContainText('标定未通过：禁止旋转补偿');
  await expect(panel).toContainText('旋转补偿后差异：—');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(panel).not.toContainText('相机角速度');
  expect(calls).toEqual([]); expect(errors).toEqual([]);
});

test('optional actual X4 Air video and sidecar remain fully local', async ({ page }) => {
  test.skip(!process.env.CITYLENS_IMU_REAL_E2E, 'Local real-world media is not part of the repository.');
  const { panel, calls, errors } = await setup(page);
  await page.getByLabel('选择 MP4 视频').setInputFiles(path.join(root, 'local-data/exports/VID_20260923_101433_00_008_360_front.mp4'));
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.getByLabel('选择 IMU 数据').setInputFiles(path.join(root, 'local-data/exports/VID_20260923_101433_00_008_imu.json'));
  await expect(panel).toContainText('已匹配当前视频指纹');
  await page.getByLabel('启用本地 IMU 对照（不上传）').check();
  await page.locator('video').evaluate(v => { (v as HTMLVideoElement).currentTime = 15; });
  await play(page);
  await expect(panel).toContainText('本地连续帧光度误差对照中');
  await expect(panel).toContainText('Insta360 X4 Air');
  await panel.screenshot({ path: path.join(root, 'work/imu-real-008.png') });
  await page.locator('video').evaluate(v => (v as HTMLVideoElement).pause());
  await expect(panel).not.toContainText('相机角速度');
  expect(calls).toEqual([]); expect(errors).toEqual([]);
});
