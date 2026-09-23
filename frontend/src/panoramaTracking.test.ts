import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanoramaTracker, projectFaceBox, projectFacePoint, trackTemplatePoint, wrapX, wrappedDelta } from './panoramaTracking';
import type { Face, GrayFrame, Point, TrackingInput, TrackingOutput, TrackingSnapshot } from './panoramaTracking';
import type { Event } from './types';

const W = 320, H = 160;
type Grounding = Event & { box?: [number, number, number, number] | null; view?: Face | null };
const faces: Face[] = ['front', 'left', 'right', 'back', 'up', 'down'];
const grounded = (overrides: Partial<Grounding> = {}): Grounding => ({
  category: 'obstacle', label: 'person', text: '原始安全文本', direction: 'front', box: [300, 300, 700, 700], view: 'front', ...overrides,
});
const result = (overrides: Partial<Extract<TrackingInput, { type: 'result' }>> = {}): Extract<TrackingInput, { type: 'result' }> => ({
  type: 'result', frameId: 10, anchorId: 1, capturedAt: 100, heading: 0, events: [grounded()], ...overrides,
});
function noise(x: number, y: number, seed = 1): number {
  let n = Math.imul(x + 10000, 374761393) ^ Math.imul(y + 10000, 668265263) ^ Math.imul(seed, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return 20 + ((n ^ (n >>> 16)) >>> 0) % 216;
}
const pixelX = (x: number) => ((x % W) + W) % W;
type SceneOptions = {
  cx?: number; cy?: number; dx?: number; dy?: number; at?: number;
  flat?: boolean; repeated?: boolean; seed?: number; background?: number; halfWidth?: number; halfHeight?: number;
};
function scene(id: number, options: SceneOptions = {}): GrayFrame {
  const { cx = 160, cy = 80, dx = 0, dy = 0, at = id * 100, seed = 4, background = 2,
    flat = false, repeated = false, halfWidth = 27, halfHeight = 25 } = options;
  const pixels = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) pixels[y * W + x] = noise(x, y, background);
  for (let y = -halfHeight; y <= halfHeight; y++) {
    for (let x = -halfWidth; x <= halfWidth; x++) {
      const py = Math.round(cy) + y + dy;
      if (py < 0 || py >= H) continue;
      pixels[py * W + pixelX(Math.round(cx) + x + dx)] = flat ? 128 : repeated
        ? noise(((x % 4) + 4) % 4, ((y % 4) + 4) % 4, seed) : noise(x, y, seed);
    }
  }
  return { id, at, width: W, height: H, pixels };
}
const first = (snapshot: TrackingSnapshot | null) => snapshot!.tracks[0];
function started(options: SceneOptions = {}) {
  const tracker = new PanoramaTracker();
  tracker.addFrame(scene(1, options));
  const snapshot = tracker.resolve(result());
  return { tracker, snapshot };
}
function expectLost(snapshot: TrackingSnapshot | null, reason?: RegExp) {
  const track = first(snapshot);
  expect(track.status).toBe('lost');
  expect(track.current).toBeNull(); expect(track.center).toBeNull();
  expect(track.yaw).toBeNull(); expect(track.pitch).toBeNull();
  expect(track.direction).toBe('unknown'); expect(track.quality).toBe(0);
  if (reason) expect(track.reason).toMatch(reason);
}

// Independent vector construction matching backend face_ray and prepare_panorama's yaw+heading.
function backendProjection(view: Face, x: number, y: number, heading: number): Point {
  const angles: Record<Face, [number, number]> = {
    front: [0, 0], left: [-90, 0], right: [90, 0], back: [180, 0], up: [0, 90], down: [0, -90],
  };
  const yaw = ((angles[view][0] + heading + 180) % 360 - 180) * Math.PI / 180;
  const pitch = angles[view][1] * Math.PI / 180;
  const forward = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = [forward[1] * right[2] - forward[2] * right[1], forward[2] * right[0] - forward[0] * right[2], forward[0] * right[1] - forward[1] * right[0]];
  const ray = forward.map((v, i) => v + (x / 500 - 1) * right[i] + (1 - y / 500) * up[i]);
  const length = Math.hypot(...ray), unit = ray.map(v => v / length);
  const longitude = Math.atan2(unit[0], unit[2]), latitude = Math.atan2(unit[1], Math.hypot(unit[0], unit[2]));
  return { x: ((0.5 + longitude / (2 * Math.PI)) % 1 + 1) % 1, y: 0.5 - latitude / Math.PI };
}

describe('六面坐标与后端公式', () => {
  it.each(faces)('%s 面中心及 heading 对照后端', view => {
    for (const heading of [-180, -90, 0, 37, 180]) {
      const actual = projectFacePoint(view, 500, 500, heading), expected = backendProjection(view, 500, 500, heading);
      expect(wrappedDelta(actual.x, expected.x)).toBeCloseTo(0, 10);
      expect(actual.y).toBeCloseTo(expected.y, 10);
    }
  });
  it.each(faces)('%s 面非中心及 heading 对照后端', view => {
    for (const heading of [-160, -45, 0, 73, 180]) {
      for (const [x, y] of [[123, 234], [900, 800], [100, 800], [900, 100], [500, 800]]) {
        const actual = projectFacePoint(view, x, y, heading), expected = backendProjection(view, x, y, heading);
        expect(wrappedDelta(actual.x, expected.x)).toBeCloseTo(0, 10);
        expect(actual.y).toBeCloseTo(expected.y, 10);
        expect(actual.x).toBeGreaterThanOrEqual(0); expect(actual.x).toBeLessThan(1);
      }
    }
  });
  it.each([
    ['up', 500, 900, 0, 1], ['up', 500, 100, 180, 1], ['up', 900, 500, 90, 1],
    ['down', 500, 100, 0, -1], ['down', 500, 900, 180, -1], ['down', 900, 500, 90, -1],
  ] as const)('%s 面姿态 %s/%s', (view, x, y, yaw, sign) => {
    const point = projectFacePoint(view, x, y);
    expect(wrappedDelta(point.x, wrapX(0.5 + yaw / 360))).toBeCloseTo(0, 10);
    expect((0.5 - point.y) * 180).toBeCloseTo(sign * Math.atan(1 / 0.8) * 180 / Math.PI, 10);
    const rotated = projectFacePoint(view, x, y, 71);
    expect(wrappedDelta(rotated.x, point.x)).toBeCloseTo(71 / 360, 10);
    expect(rotated.y).toBeCloseTo(point.y, 10);
  });
  it('细分真实曲边而非连接四角或把面框当作ERP框', () => {
    const boundary = projectFaceBox('front', [0, 0, 1000, 1000]);
    expect(boundary).toHaveLength(129);
    expect(boundary[128]).toEqual(boundary[0]);
    expect(boundary[16]).toEqual(projectFacePoint('front', 500, 0));
    expect(Math.abs(boundary[16].y - (boundary[0].y + boundary[32].y) / 2)).toBeGreaterThan(0.05);
    expect(boundary[0].x).toBeCloseTo(0.375);
  });
  it('接缝轮廓保持归一化并可按最短水平差连线', () => {
    const boundary = projectFaceBox('back', [300, 300, 700, 700]);
    expect(boundary.some(p => p.x < 0.1)).toBe(true); expect(boundary.some(p => p.x > 0.9)).toBe(true);
    boundary.forEach((p, i) => {
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThan(1);
      if (i) expect(Math.abs(wrappedDelta(p.x, boundary[i - 1].x))).toBeLessThan(0.01);
    });
  });
});

describe('真实帧历史与生命周期', () => {
  it('没有结果只保存历史，不造成功；只有锚帧时明确waiting', () => {
    const tracker = new PanoramaTracker();
    expect(tracker.addFrame(scene(1))).toBeNull();
    const snapshot = tracker.resolve(result());
    expect(first(snapshot).status).toBe('waiting'); expect(first(snapshot).current).toBeNull();
    expect(first(snapshot).center).toBeNull(); expect(first(snapshot).quality).toBe(0);
    expect(first(snapshot).original).toHaveLength(129); expect(snapshot.message).toContain('尚未跟踪成功');
  });
  it('没有任何帧仍返回明确的lost快照', () => {
    const snapshot = new PanoramaTracker().resolve(result());
    expectLost(snapshot, /锚帧/); expect(snapshot.historyFrames).toBe(0);
    expect(snapshot.frameId).toBe(10); expect(snapshot.capturedAt).toBe(100);
  });
  it.each([false, true])('空events返回明确快照，有帧=%s', hasFrame => {
    const tracker = new PanoramaTracker();
    if (hasFrame) tracker.addFrame(scene(1));
    const snapshot = tracker.resolve(result({ events: [] }));
    expect(snapshot.tracks).toEqual([]); expect(snapshot.message).toContain('没有可跟踪目标');
    expect(tracker.addFrame(scene(2))!.tracks).toEqual([]);
  });
  it('只使用anchorId，不把分析frameId或最近帧当作锚帧', () => {
    const tracker = new PanoramaTracker();
    for (let id = 101; id <= 105; id++) tracker.addFrame(scene(id, { dx: (id - 101) * 3 }));
    const snapshot = tracker.resolve(result({ frameId: 7, anchorId: 102, capturedAt: 10200 }));
    expect(first(snapshot).status).toBe('tracking');
    expect(first(snapshot).center!.x).toBeCloseTo(0.5 + 9 / W);
    expect(snapshot.frameId).toBe(7); expect(snapshot.capturedAt).toBe(10200); expect(snapshot.observedAt).toBe(10500);
  });
  it('逐帧回放折返轨迹，再随新帧更新，不用首尾一次匹配代替', () => {
    const tracker = new PanoramaTracker();
    [0, 4, 8, 12, 16, 12, 8, 4].forEach((dx, i) => tracker.addFrame(scene(i + 1, { dx })));
    const snapshot = tracker.resolve(result());
    expect(first(snapshot).status).toBe('tracking'); expect(first(snapshot).center!.x).toBeCloseTo(0.5 + 4 / W);
    expect(snapshot.historyFrames).toBe(8);
    const next = tracker.addFrame(scene(9, { dx: 8 }));
    expect(first(next).status).toBe('tracking'); expect(first(next).center!.x).toBeCloseTo(0.5 + 8 / W);
    expect(first(next).original).toEqual(first(snapshot).original);
  });
  it('中间遮挡即永久lost，首尾相同也不跳过中间真实帧', () => {
    const tracker = new PanoramaTracker();
    tracker.addFrame(scene(1)); tracker.addFrame(scene(2, { flat: true })); tracker.addFrame(scene(3));
    expectLost(tracker.resolve(result()));
    expectLost(tracker.addFrame(scene(4)));
  });
  it('锚帧ID缺失时不使用邻近ID，后续帧也不自动认领', () => {
    const tracker = new PanoramaTracker(); tracker.addFrame(scene(1)); tracker.addFrame(scene(3));
    expectLost(tracker.resolve(result({ anchorId: 2 })), /锚帧/);
    expectLost(tracker.addFrame(scene(4)));
  });
  it('ID可跳号，但只能由真实时间连续的帧驱动', () => {
    const tracker = new PanoramaTracker(); tracker.addFrame(scene(1)); tracker.resolve(result());
    expect(first(tracker.addFrame(scene(30, { at: 200, dx: 2 }))).status).toBe('tracking');
  });
  it.each([601, 900])('缺帧导致间隔%s毫秒时lost', gap => {
    const { tracker } = started(); expectLost(tracker.addFrame(scene(2, { at: 100 + gap, dx: 1 })), /600/);
  });
  it('600毫秒边界可验证，回放内部超过边界则lost', () => {
    const { tracker } = started(); expect(first(tracker.addFrame(scene(2, { at: 700, dx: 1 }))).status).toBe('tracking');
    const replay = new PanoramaTracker();
    replay.addFrame(scene(1)); replay.addFrame(scene(2, { at: 701 })); replay.addFrame(scene(3, { at: 800 }));
    expectLost(replay.resolve(result()), /600/);
  });
  it('严格限制120帧，并让被淘汰锚帧明确lost', () => {
    const tracker = new PanoramaTracker();
    for (let id = 1; id <= 125; id++) tracker.addFrame(scene(id));
    const snapshot = tracker.resolve(result());
    expect(snapshot.historyFrames).toBe(120); expectLost(snapshot, /锚帧/);
    const history = (tracker as unknown as { history: GrayFrame[] }).history;
    expect(history[0].id).toBe(6);
    expect(history.every(f => f.width === W && f.height === H && f.pixels.byteLength === W * H)).toBe(true);
    expect(history.reduce((sum, f) => sum + f.pixels.byteLength, 0)).toBe(6_144_000);
  });
  it('历史保留不超过16秒，包括准确时间边界', () => {
    const tracker = new PanoramaTracker();
    tracker.addFrame(scene(1, { at: 0 })); tracker.addFrame(scene(2, { at: 16000 }));
    expect(tracker.resolve(result({ events: [] })).historyFrames).toBe(2);
    tracker.addFrame(scene(3, { at: 16001 }));
    const snapshot = tracker.resolve(result({ frameId: 11 }));
    expect(snapshot.historyFrames).toBe(2); expectLost(snapshot, /锚帧/);
  });
  it('连续匹配也不能无限沿用超过16秒的旧语义', () => {
    const { tracker } = started();
    for (let id = 2; id <= 161; id++) tracker.addFrame(scene(id));
    expectLost(tracker.addFrame(scene(162)), /超过16秒/);
  });
  it.each([1, 0])('非递增帧ID %s 被拒绝，旧轨迹丢失', id => {
    const { tracker } = started(); expectLost(tracker.addFrame(scene(id, { at: 200 })), /编号/);
    expectLost(tracker.addFrame(scene(2, { at: 300 })));
  });
  it.each([100, 99, NaN])('拒绝无序或无效帧时间 %s', at => {
    const { tracker } = started(); expectLost(tracker.addFrame(scene(2, { at })), /时间/);
  });
  it('尺寸变化清空历史、丢失旧轨迹；存储始终为320x160', () => {
    const { tracker } = started();
    const snapshot = tracker.addFrame({ id: 2, at: 200, width: 640, height: 320, pixels: new Uint8Array(640 * 320) });
    expectLost(snapshot, /尺寸变化/); expect(snapshot!.historyFrames).toBe(1);
    const history = (tracker as unknown as { history: GrayFrame[] }).history;
    expect(history[0].pixels.byteLength).toBe(W * H); expect(history[0].id).toBe(2);
    expectLost(tracker.resolve(result({ frameId: 11 })), /锚帧/);
  });
  it.each([
    { width: 321 }, { pixels: new Uint8Array(12) }, { width: 8192, height: 4096 }, { width: 0, height: 0 },
  ])('无效输入尺寸或数据不能继续轨迹 %j', override => {
    const { tracker } = started(); expectLost(tracker.addFrame({ ...scene(2), ...override }), /尺寸|数据/);
  });
  it('重复或迟到分析结果不重启lost目标', () => {
    const { tracker } = started(); tracker.addFrame(scene(2, { flat: true })); tracker.addFrame(scene(3));
    const duplicate = tracker.resolve(result({ anchorId: 3 }));
    expectLost(duplicate); expect(duplicate.message).toContain('忽略');
    expectLost(tracker.resolve(result({ frameId: 9, anchorId: 3 })));
    expect(first(tracker.resolve(result({ frameId: 11, anchorId: 3 }))).status).toBe('waiting');
  });
  it('最多六项目标，ID为事件index，label只保留event.text', () => {
    const tracker = new PanoramaTracker(); tracker.addFrame(scene(1));
    const events = Array.from({ length: 10 }, (_, i) => grounded({ text: `<img src=x onerror=alert(${i})>`, label: '不是显示文本' }));
    const snapshot = tracker.resolve(result({ events }));
    expect(snapshot.tracks).toHaveLength(6);
    snapshot.tracks.forEach((track, i) => { expect(track.id).toBe(i); expect(track.label).toBe(events[i].text); });
  });
  it('输入events/像素/快照互不污染，保留原方向和原轮廓', () => {
    const tracker = new PanoramaTracker(); const frame = scene(1), savedPixels = frame.pixels.slice();
    const event = grounded({ direction: 'left' }); Object.freeze(event.box); Object.freeze(event);
    const input = result({ events: [event] }); Object.freeze(input.events); Object.freeze(input);
    tracker.addFrame(frame); frame.pixels.fill(0);
    const snapshot = tracker.resolve(input), original = structuredClone(first(snapshot).original);
    first(snapshot).original[0].x = 99;
    const next = tracker.addFrame(scene(2, { dx: 2 }));
    expect(first(next).status).toBe('tracking'); expect(first(next).original).toEqual(original);
    expect(first(next).originalDirection).toBe('left'); expect(event.direction).toBe('left'); expect(event.box).toEqual([300, 300, 700, 700]);
    const history = (tracker as unknown as { history: GrayFrame[] }).history;
    expect(history[0].pixels).toEqual(savedPixels);
    first(next).current![0].x = 88; first(next).center!.x = 77;
    expect(first(tracker.addFrame(scene(3, { dx: 3 }))).center!.x).toBeCloseTo(0.5 + 3 / W);
  });
});

describe('保守多点局部模板跟踪', () => {
  it.each(['front', 'left', 'right', 'back'] as const)('%s 面小步平移与固定heading方向', view => {
    const heading = 31, origin = projectFacePoint(view, 500, 500, heading);
    const tracker = new PanoramaTracker();
    tracker.addFrame(scene(1, { cx: origin.x * W }));
    tracker.resolve(result({ heading, events: [grounded({ view, direction: view })] }));
    const snapshot = tracker.addFrame(scene(2, { cx: origin.x * W, dx: 3, dy: -2 }));
    const track = first(snapshot);
    expect(track.status).toBe('tracking'); expect(track.direction).toBe(view);
    expect(wrappedDelta(track.center!.x, origin.x)).toBeCloseTo(3 / W); expect(track.center!.y).toBeCloseTo(origin.y - 2 / H);
    expect(track.pitch).toBeCloseTo(2 / H * 180); expect(track.quality).toBeGreaterThan(0.5);
    expect(track.quality).toBeLessThanOrEqual(1); expect(track.reason).toContain('不是概率');
    track.current!.forEach((p, i) => {
      expect(wrappedDelta(p.x, track.original[i].x)).toBeCloseTo(3 / W);
      expect(p.y - track.original[i].y).toBeCloseTo(-2 / H);
    });
  });
  it('跨±180接缝保持同一组内部点，水平方向wrap不丢失', () => {
    const tracker = new PanoramaTracker(), origin = projectFacePoint('back', 500, 500, -1);
    tracker.addFrame(scene(1, { cx: origin.x * W }));
    tracker.resolve(result({ heading: -1, events: [grounded({ view: 'back', direction: 'back' })] }));
    for (let id = 2; id <= 5; id++) {
      const track = first(tracker.addFrame(scene(id, { cx: origin.x * W, dx: (id - 1) * 3 })));
      expect(track.status).toBe('tracking'); expect(track.direction).toBe('back'); expect(track.center!.x).toBeLessThan(0.05);
      expect(wrappedDelta(track.center!.x, origin.x)).toBeCloseTo((id - 1) * 3 / W);
    }
  });
  it('同一目标以小步跨越front/right面边界，不限制在原面内', () => {
    const box: [number, number, number, number] = [600, 250, 1000, 750];
    const origin = projectFacePoint('front', 800, 500), tracker = new PanoramaTracker();
    tracker.addFrame(scene(1, { cx: origin.x * W }));
    tracker.resolve(result({ events: [grounded({ box })] }));
    let snapshot: TrackingSnapshot | null = null;
    for (let id = 2; id <= 7; id++) snapshot = tracker.addFrame(scene(id, { cx: origin.x * W, dx: (id - 1) * 3 }));
    expect(first(snapshot).status).toBe('tracking'); expect(first(snapshot).direction).toBe('right');
    expect(first(snapshot).yaw).toBeGreaterThan(45); expect(first(snapshot).originalDirection).toBe('front');
  });
  it.each(['up', 'down'] as const)('%s 近极点明确unsupported', view => {
    const tracker = new PanoramaTracker(); tracker.addFrame(scene(1));
    const track = first(tracker.resolve(result({ events: [grounded({ view })] })));
    expect(track.status).toBe('unsupported'); expect(track.reason).toContain('极区'); expect(track.current).toBeNull();
    expect(track.original).toHaveLength(129);
  });
  it.each(['up', 'down'] as const)('%s 非极区面边区域可做同样局部验证', view => {
    // A sufficiently large side strip: its entire boundary remains below 65 degrees latitude.
    const box: [number, number, number, number] = [0, 200, 250, 800];
    const origin = projectFacePoint(view, 125, 500, 33), tracker = new PanoramaTracker();
    const options = { cx: origin.x * W, cy: origin.y * H, halfWidth: 55, halfHeight: 30 };
    tracker.addFrame(scene(1, options)); tracker.resolve(result({ heading: 33, events: [grounded({ view, box })] }));
    const track = first(tracker.addFrame(scene(2, { ...options, dx: 2 })));
    expect(track.status, track.reason).toBe('tracking'); expect(wrappedDelta(track.center!.x, origin.x)).toBeCloseTo(2 / W);
  });
  it.each(['up', 'down'] as const)('%s 原本可跟踪，但平移后轮廓进入极区则lost', view => {
    const box: [number, number, number, number] = [0, 200, 250, 800];
    const origin = projectFacePoint(view, 125, 500, 33), tracker = new PanoramaTracker();
    const options = { cx: origin.x * W, cy: origin.y * H, halfWidth: 55, halfHeight: 30 };
    tracker.addFrame(scene(1, options));
    expect(first(tracker.resolve(result({ heading: 33, events: [grounded({ view, box })] }))).status).toBe('waiting');
    expectLost(tracker.addFrame(scene(2, { ...options, dy: view === 'up' ? -2 : 2 })), /进入极区/);
  });
  it.each(['up', 'down'] as const)('%s 非极区小框仍必须满足内部点数量和分布下限', view => {
    const box: [number, number, number, number] = [700, 700, 1000, 1000];
    const origin = projectFacePoint(view, 850, 850, 33), tracker = new PanoramaTracker();
    tracker.addFrame(scene(1, { cx: origin.x * W, cy: origin.y * H, halfWidth: 34, halfHeight: 30 }));
    expectLost(tracker.resolve(result({ heading: 33, events: [grounded({ view, box })] })), /内部纹理点不足|分布不足/);
  });
  it('无效heading不能产生可跟踪的投影', () => {
    const tracker = new PanoramaTracker(); tracker.addFrame(scene(1));
    const track = first(tracker.resolve(result({ heading: NaN })));
    expect(track.status).toBe('unsupported'); expect(track.current).toBeNull();
  });
  it.each([{ box: null }, { view: null }, { box: [0, 0, 1001, 500] }, { box: [500, 500, 400, 700] }, { box: [NaN, 0, 500, 500] }] as Partial<Grounding>[])
    ('缺少或无效面内框明确unsupported %j', fields => {
      const tracker = new PanoramaTracker(); tracker.addFrame(scene(1));
      expect(first(tracker.resolve(result({ events: [grounded(fields)] }))).status).toBe('unsupported');
    });
  it('目标内部纹理不足，不能借周围背景通过', () => {
    expectLost(started({ flat: true }).snapshot, /内部纹理/);
  });
  it('重复图案出现多个同分最佳候选时lost', () => {
    const { tracker } = started({ repeated: true });
    expectLost(tracker.addFrame(scene(2, { repeated: true, dx: 2 })), /不唯一|重复/);
  });
  it('遮挡导致lost；之后相同目标/其他纹理回来也不自动重认', () => {
    const { tracker } = started();
    expectLost(tracker.addFrame(scene(2, { flat: true })), /匹配|遮挡|纹理/);
    expectLost(tracker.addFrame(scene(3))); expectLost(tracker.addFrame(scene(4, { seed: 55 })));
  });
  it.each([7, 18])('超过局部运动限制%s像素时lost', dx => {
    const { tracker } = started(); expectLost(tracker.addFrame(scene(2, { dx })), /运动|匹配/);
  });
  it('内部左右区域不同位移不应声称一致平移', () => {
    const { tracker } = started();
    const left = scene(2, { dx: -3 }), right = scene(2, { dx: 3 });
    for (let y = 50; y <= 110; y++) for (let x = 160; x < 193; x++) left.pixels[y * W + x] = right.pixels[y * W + x];
    expectLost(tracker.addFrame(left), /多点|匹配/);
  });
  it('背景大幅变化或切镜时，即使目标纹理完全相同也lost', () => {
    const { tracker } = started(); expectLost(tracker.addFrame(scene(2, { background: 29 })), /背景|切镜/);
  });
  it('全画面一致运动也停止，不用背景估计补偿相机朝向', () => {
    const { tracker } = started(); const original = scene(1), moved = scene(2);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) moved.pixels[y * W + x] = original.pixels[y * W + pixelX(x - 4)];
    expectLost(tracker.addFrame(moved), /背景/);
  });
  it('背景纹理和分布不足时，目标匹配本身不能制造成功', () => {
    const tracker = new PanoramaTracker(), a = scene(1), b = scene(2, { dx: 2 });
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (x < 125 || x > 195 || y < 48 || y > 112) { a.pixels[y * W + x] = 128; b.pixels[y * W + x] = 128; }
    }
    tracker.addFrame(a); tracker.resolve(result()); expectLost(tracker.addFrame(b), /背景纹理不足/);
  });
  it('累计外观漂移不能靠不断更新模板重新认领', () => {
    const { tracker } = started(); let snapshot: TrackingSnapshot | null = null;
    for (let id = 2; id <= 5; id++) {
      const frame = scene(id);
      for (let y = 55; y <= 105; y++) for (let x = 133; x <= 187; x++) frame.pixels[y * W + x] = Math.min(255, frame.pixels[y * W + x] + (id - 1) * 8);
      snapshot = tracker.addFrame(frame);
    }
    expectLost(snapshot, /锚帧|匹配/);
  });
});

describe('独立前后向验证与worker消息', () => {
  it('单点前向唯一但反向回到相似的另一处时拒绝', () => {
    const before = scene(1), after = scene(2);
    // A at 100 differs by eight gray levels from B at 110. A->B at 105 is a good
    // forward match, but the backward best match is B at 110, not the original A.
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const b = noise(dx, dy, 8);
      before.pixels[(80 + dy) * W + 100 + dx] = b + 8;
      before.pixels[(80 + dy) * W + 110 + dx] = b;
      after.pixels[(80 + dy) * W + 105 + dx] = b;
    }
    const match = trackTemplatePoint(before, after, { x: 100 / W, y: 80 / H });
    expect(match.ok).toBe(false);
    if (!match.ok) expect(match.reason).toContain('前后向');
  });
  it('一维条纹不作为可靠内部纹理点', () => {
    const frame = scene(1);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) frame.pixels[y * W + x] = (x % 4) * 60;
    const match = trackTemplatePoint(frame, { ...frame, id: 2, at: 200 }, { x: 0.5, y: 0.5 });
    expect(match.ok).toBe(false); if (!match.ok) expect(match.reason).toContain('纹理不足');
  });
  afterEach(() => vi.unstubAllGlobals());
  it('worker帧消息先ack，再返回可能的snapshot；result只返回snapshot', async () => {
    const messages: TrackingOutput[] = [];
    const scope = { postMessage: (message: TrackingOutput) => messages.push(message), onmessage: null as ((event: MessageEvent<TrackingInput>) => void) | null };
    vi.stubGlobal('self', scope);
    await import('./panoramaTracking.worker');
    const send = (data: TrackingInput) => scope.onmessage!({ data } as MessageEvent<TrackingInput>);
    send({ type: 'frame', frame: scene(1) }); expect(messages.map(m => m.type)).toEqual(['ack']);
    send(result()); expect(messages.map(m => m.type)).toEqual(['ack', 'snapshot']);
    send({ type: 'frame', frame: scene(2, { dx: 2 }) });
    expect(messages.map(m => m.type)).toEqual(['ack', 'snapshot', 'ack', 'snapshot']);
    expect(messages[2]).toEqual({ type: 'ack', id: 2 });
    const last = messages[3]; if (last.type === 'snapshot') expect(first(last.snapshot).status).toBe('tracking');
  });
});
