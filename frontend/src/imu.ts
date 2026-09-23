export type Quaternion = [number, number, number, number];
export type ImuRecording = {
  version: 1;
  camera: string;
  video: { name: string; size: number; fingerprint: string; duration: number };
  calibration: { accepted: boolean; improvement: number; baseline_error: number; compensated_error: number; pairs: number };
  samples: number[][];
};
export type ImuSample = { quaternion: Quaternion; angularSpeed: number; accelerationNorm: number };
type GrayImage = { pixels: Uint8Array; width: number; height: number };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function parseImuRecording(text: string): ImuRecording {
  if (text.length > 10 * 1024 * 1024) throw new Error('IMU 文件超过10 MB。');
  let data: ImuRecording;
  try { data = JSON.parse(text) as ImuRecording; } catch { throw new Error('IMU 文件不是有效 JSON。'); }
  const fail = () => { throw new Error('IMU 数据格式无效，请用 x4_imu_compare 工具生成。'); };
  if (!data || data.version !== 1 || typeof data.camera !== 'string' || data.camera.length > 100 ||
    !data.video || typeof data.video.name !== 'string' || data.video.name.length > 300 ||
    !Number.isSafeInteger(data.video.size) || data.video.size <= 0 || typeof data.video.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.video.fingerprint) || !finite(data.video.duration) || data.video.duration <= 0 ||
    !data.calibration || typeof data.calibration.accepted !== 'boolean' ||
    !finite(data.calibration.improvement) || !finite(data.calibration.baseline_error) || data.calibration.baseline_error < 0 ||
    !finite(data.calibration.compensated_error) || data.calibration.compensated_error < 0 ||
    !Number.isSafeInteger(data.calibration.pairs) || data.calibration.pairs < 1 ||
    !Array.isArray(data.samples) || data.samples.length < 2 || data.samples.length > 100_000) fail();
  let last = -Infinity;
  for (const row of data.samples) {
    if (!Array.isArray(row) || row.length !== 7 || !row.every(finite) || row[0] <= last ||
      Math.abs(row[0]) > 86400 || Math.abs(Math.hypot(...row.slice(1, 5)) - 1) > 0.001 ||
      row[5] < 0 || row[5] > 10000 || row[6] < 0 || row[6] > 128) fail();
    last = row[0];
  }
  return data;
}

export async function matchesImuVideo(recording: ImuRecording, file: File): Promise<boolean> {
  if (file.size !== recording.video.size) return false;
  const size = new TextEncoder().encode(String(file.size));
  const first = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const last = new Uint8Array(await file.slice(Math.max(0, file.size - 65536)).arrayBuffer());
  const bytes = new Uint8Array(size.length + first.length + last.length);
  bytes.set(size); bytes.set(first, size.length); bytes.set(last, size.length + first.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('') === recording.video.fingerprint;
}

export function sampleImu(recording: ImuRecording, seconds: number): ImuSample | null {
  const rows = recording.samples;
  if (!Number.isFinite(seconds) || seconds < rows[0][0] || seconds > rows.at(-1)![0]) return null;
  let low = 0, high = rows.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle][0] <= seconds) low = middle; else high = middle;
  }
  const a = rows[low], b = rows[high], gap = b[0] - a[0];
  if (gap > 0.05) return null;
  const fraction = (seconds - a[0]) / gap;
  const sign = a.slice(1, 5).reduce((sum, value, i) => sum + value * b[i + 1], 0) < 0 ? -1 : 1;
  const q = a.slice(1, 5).map((value, i) => value * (1 - fraction) + sign * b[i + 1] * fraction);
  const norm = Math.hypot(...q);
  return { quaternion: q.map(value => value / norm) as Quaternion,
    angularSpeed: a[5] * (1 - fraction) + b[5] * fraction,
    accelerationNorm: a[6] * (1 - fraction) + b[6] * fraction };
}

function multiply(a: number[], b: number[]): Quaternion {
  const [x, y, z, w] = a, [i, j, k, r] = b;
  return [w*i + x*r + y*k - z*j, w*j - x*k + y*r + z*i, w*k + x*j - y*i + z*r, w*r - x*i - y*j - z*k];
}

export function rotateRay(q: number[], ray: number[]): number[] {
  const [x, y, z, w] = q, [a, b, c] = ray;
  const tx = 2 * (y*c - z*b), ty = 2 * (z*a - x*c), tz = 2 * (x*b - y*a);
  return [a + w*tx + y*tz - z*ty, b + w*ty + z*tx - x*tz, c + w*tz + x*ty - y*tx];
}

function pixel(image: GrayImage, x: number, y: number): number {
  x = ((x % image.width) + image.width) % image.width;
  y = Math.max(0, Math.min(image.height - 1, y));
  const left = Math.floor(x), top = Math.floor(y), right = (left + 1) % image.width, bottom = Math.min(top + 1, image.height - 1);
  const dx = x - left, dy = y - top;
  return (image.pixels[top * image.width + left] * (1 - dx) + image.pixels[top * image.width + right] * dx) * (1 - dy) +
    (image.pixels[bottom * image.width + left] * (1 - dx) + image.pixels[bottom * image.width + right] * dx) * dy;
}

export function compareImuFrames(before: GrayImage, after: GrayImage, qBefore: number[], qAfter: number[]): { baseline: number; compensated: number } {
  if (before.width !== 320 || before.height !== 160 || after.width !== 320 || after.height !== 160 ||
    before.pixels.length !== 51200 || after.pixels.length !== 51200) throw new Error('IMU 对照要求320×160灰度帧。');
  // Map current camera rays back to the previous camera, not the opposite direction.
  const relative = multiply(qBefore, [-qAfter[0], -qAfter[1], -qAfter[2], qAfter[3]]);
  const raw: number[] = [], corrected: number[] = [];
  for (let y = 32; y < 120; y += 4) {
    for (let x = 8; x < 320; x += 8) {
      const lon = (x / 320 - 0.5) * 2 * Math.PI, lat = (0.5 - y / 160) * Math.PI;
      const ray = rotateRay(relative, [Math.sin(lon) * Math.cos(lat), Math.sin(lat), Math.cos(lon) * Math.cos(lat)]);
      const px = (0.5 + Math.atan2(ray[0], ray[2]) / (2 * Math.PI)) * 320;
      const py = (0.5 - Math.atan2(ray[1], Math.hypot(ray[0], ray[2])) / Math.PI) * 160;
      const current = after.pixels[y * 320 + x];
      raw.push(Math.abs(before.pixels[y * 320 + x] - current));
      corrected.push(Math.abs(pixel(before, px, py) - current));
    }
  }
  const trimmed = (values: number[]) => {
    const sorted = values.sort((a, b) => a - b).slice(0, Math.floor(values.length * 0.8));
    return sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  };
  return { baseline: trimmed(raw), compensated: trimmed(corrected) };
}
