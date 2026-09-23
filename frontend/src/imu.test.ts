import { describe, expect, it } from 'vitest';
import { compareImuFrames, matchesImuVideo, parseImuRecording, rotateRay, sampleImu, type ImuRecording } from './imu';

function recording(): ImuRecording {
  return { version: 1, camera: 'Insta360 X4 Air', video: { name: 'test.mp4', size: 10, fingerprint: 'a'.repeat(64), duration: 1 },
    calibration: { accepted: true, improvement: 0.3, baseline_error: 10, compensated_error: 7, pairs: 12 },
    samples: [[0, 0, 0, 0, 1, 10, 1], [0.01, 0, 0, 0, 1, 20, 1.2]] };
}

const image = (shift = 0) => ({ width: 320, height: 160, pixels: Uint8Array.from({ length: 51200 }, (_, i) => {
  const x = ((i % 320 - shift) + 320) % 320, y = Math.floor(i / 320);
  return Math.round(128 + 50 * Math.sin(x * Math.PI / 20) + 30 * Math.cos(y * Math.PI / 16));
}) });

describe('local IMU sidecar', () => {
  it('parses generated data and interpolates using video seconds', () => {
    const data = parseImuRecording(JSON.stringify(recording()));
    expect(sampleImu(data, 0.005)).toEqual({ quaternion: [0, 0, 0, 1], angularSpeed: 15, accelerationNorm: 1.1 });
    expect(sampleImu(data, 0.01)?.angularSpeed).toBe(20);
    expect(sampleImu(data, Date.now())).toBeNull();
    expect(sampleImu(data, -0.1)).toBeNull();
    expect(sampleImu(data, NaN)).toBeNull();
  });

  it('never interpolates through a missing segment or opposing quaternion signs', () => {
    const data = recording();
    data.samples[1][4] = -1;
    expect(sampleImu(data, 0.005)?.quaternion).toEqual([0, 0, 0, 1]);
    data.samples[1][0] = 0.1;
    expect(sampleImu(data, 0.05)).toBeNull();
  });

  it.each(['null', '{}', '[]', '{', JSON.stringify({ ...recording(), samples: [] })])('rejects malformed sidecars %s', text => {
    expect(() => parseImuRecording(text)).toThrow();
  });

  it.each(['time', 'quaternion', 'speed', 'size', 'row'])('rejects invalid %s', field => {
    const data = recording();
    if (field === 'time') data.samples[1][0] = 0;
    if (field === 'quaternion') data.samples[1][4] = 0;
    if (field === 'speed') data.samples[0][5] = -1;
    if (field === 'size') data.video.size = -1;
    if (field === 'row') data.samples[1].push(42);
    expect(() => parseImuRecording(JSON.stringify(data))).toThrow();
  });

  it('binds a sidecar to local video bytes, allowing renames but rejecting another file', async () => {
    const file = new File(['local-video'], 'renamed.mp4');
    const data = recording();
    data.video.size = file.size;
    const text = String(file.size) + 'local-video' + 'local-video';
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    data.video.fingerprint = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
    expect(await matchesImuVideo(data, file)).toBe(true);
    expect(await matchesImuVideo(data, new File(['other-video'], 'test.mp4'))).toBe(false);
    expect(await matchesImuVideo(data, new File(['different size'], 'test.mp4'))).toBe(false);
  });
});

describe('spherical gyro rotation comparison', () => {
  it('reports no change for identity and exactly cancels a known panorama rotation', () => {
    expect(compareImuFrames(image(), image(), [0, 0, 0, 1], [0, 0, 0, 1])).toEqual({ baseline: 0, compensated: 0 });
    const angle = 16 / 320 * 2 * Math.PI;
    const result = compareImuFrames(image(), image(16), [0, 0, 0, 1], [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)]);
    expect(result.baseline).toBeGreaterThan(10);
    expect(result.compensated).toBeLessThan(1e-10);
    const wrong = compareImuFrames(image(), image(16), [0, 0, 0, 1], [0, -Math.sin(angle / 2), 0, Math.cos(angle / 2)]);
    expect(wrong.compensated).toBeGreaterThan(1);
  });

  it('uses relative rather than absolute orientation after playback begins in the middle', () => {
    const q = (pixels: number) => [0, Math.sin(pixels / 320 * Math.PI), 0, Math.cos(pixels / 320 * Math.PI)];
    const result = compareImuFrames(image(100), image(116), q(100), q(116));
    expect(result.compensated).toBeLessThan(1e-10);
  });

  it('rotates non-yaw rays and rejects mismatched gray buffers', () => {
    const ray = rotateRay([Math.SQRT1_2, 0, 0, Math.SQRT1_2], [0, 0, 1]);
    expect(ray[0]).toBeCloseTo(0); expect(ray[1]).toBeCloseTo(-1); expect(ray[2]).toBeCloseTo(0);
    expect(() => compareImuFrames({ ...image(), width: 160 }, image(), [0, 0, 0, 1], [0, 0, 0, 1])).toThrow();
  });
});
