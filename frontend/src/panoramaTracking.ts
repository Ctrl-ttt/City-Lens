import type { Event } from './types';

export type Point = { x: number; y: number };
export type PanoramaTrack = {
  id: number;
  label: string;
  original: Point[];
  current: Point[] | null;
  center: Point | null;
  originalDirection: Event['direction'];
  direction: Event['direction'];
  status: 'tracking' | 'lost' | 'unsupported' | 'waiting';
  reason: string;
  quality: number;
  yaw: number | null;
  pitch: number | null;
};
export type TrackingSnapshot = {
  frameId: number;
  capturedAt: number;
  observedAt: number;
  historyFrames: number;
  tracks: PanoramaTrack[];
  message: string;
};
export type GrayFrame = { id: number; at: number; width: number; height: number; pixels: Uint8Array };
export type TrackingInput =
  | { type: 'frame'; frame: GrayFrame }
  | { type: 'result'; frameId: number; anchorId: number; capturedAt: number; heading: number; events: Event[] };
export type TrackingOutput = { type: 'ack'; id: number } | { type: 'snapshot'; snapshot: TrackingSnapshot };
export type Face = 'front' | 'left' | 'right' | 'back' | 'up' | 'down';
type Box = [number, number, number, number];
type ResultInput = Extract<TrackingInput, { type: 'result' }>;

const FACES: Record<Face, [number, number]> = {
  front: [0, 0], left: [-90, 0], right: [90, 0], back: [180, 0], up: [0, 90], down: [0, -90],
};
const WIDTH = 320, HEIGHT = 160;
const MAX_HISTORY = 120, HISTORY_MS = 16_000, MAX_GAP_MS = 600;
const PATCH_RADIUS = 3, SEARCH_RADIUS = 8, MAX_STEP = 6;
const MIN_POINTS = 5, MAX_POINTS = 9, POLAR_MARGIN = 0.14;
const RAD = Math.PI / 180;
export const wrapX = (x: number): number => ((x % 1) + 1) % 1;
export const wrappedDelta = (x: number, origin: number): number => wrapX(x - origin + 0.5) - 0.5;
const wrapPixel = (x: number, width: number) => ((x % width) + width) % width;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** backend/panorama.py face_ray, with prepare_panorama's heading added to every face yaw. */
export function projectFacePoint(view: Face, x: number, y: number, heading = 0): Point {
  const yaw = (FACES[view][0] + heading) * RAD, pitch = FACES[view][1] * RAD;
  const u = x / 500 - 1, v = 1 - y / 500;
  const rx = Math.sin(yaw) * Math.cos(pitch) + u * Math.cos(yaw) - v * Math.sin(yaw) * Math.sin(pitch);
  const ry = Math.sin(pitch) + v * Math.cos(pitch);
  const rz = Math.cos(yaw) * Math.cos(pitch) - u * Math.sin(yaw) - v * Math.cos(yaw) * Math.sin(pitch);
  return { x: wrapX(0.5 + Math.atan2(rx, rz) / (2 * Math.PI)), y: 0.5 - Math.atan2(ry, Math.hypot(rx, rz)) / Math.PI };
}

/** Closed, subdivided face boundary, NOT an ERP bbox. Render horizontal edges with wrap/splitting. */
export function projectFaceBox(view: Face, box: Box, heading = 0): Point[] {
  const [x1, y1, x2, y2] = box;
  const corners = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
  const points: Point[] = [];
  for (let edge = 0; edge < 4; edge++) {
    for (let i = 0; i < 32; i++) {
      const t = i / 32;
      points.push(projectFacePoint(view,
        corners[edge][0] * (1 - t) + corners[edge + 1][0] * t,
        corners[edge][1] * (1 - t) + corners[edge + 1][1] * t, heading));
    }
  }
  points.push({ ...points[0] });
  return points;
}

function inFaceBox(point: Point, view: Face, box: Box, heading: number): boolean {
  const yaw = (FACES[view][0] + heading) * RAD, pitch = FACES[view][1] * RAD;
  const lon = (point.x - 0.5) * Math.PI * 2, lat = (0.5 - point.y) * Math.PI;
  const x = Math.sin(lon) * Math.cos(lat), y = Math.sin(lat), z = Math.cos(lon) * Math.cos(lat);
  const forward = x * Math.sin(yaw) * Math.cos(pitch) + y * Math.sin(pitch) + z * Math.cos(yaw) * Math.cos(pitch);
  if (forward <= 0) return false;
  const right = x * Math.cos(yaw) - z * Math.sin(yaw);
  const up = -x * Math.sin(yaw) * Math.sin(pitch) + y * Math.cos(pitch) - z * Math.cos(yaw) * Math.sin(pitch);
  const fx = 500 * (1 + right / forward), fy = 500 * (1 - up / forward);
  return fx > box[0] && fx < box[2] && fy > box[1] && fy < box[3];
}

function direction(yaw: number, pitch: number): Event['direction'] {
  if (pitch > 40) return 'above';
  if (Math.abs(yaw) >= 135) return 'back';
  if (yaw < -45) return 'left';
  if (yaw > 45) return 'right';
  return 'front';
}
const polar = (p: Point) => p.y < POLAR_MARGIN || p.y > 1 - POLAR_MARGIN;
const pixelPoint = (frame: GrayFrame, point: Point): Point => ({
  x: wrapPixel(Math.round(point.x * frame.width), frame.width), y: Math.round(point.y * frame.height),
});

function patch(frame: GrayFrame, x: number, y: number): Uint8Array | null {
  if (y - PATCH_RADIUS < 0 || y + PATCH_RADIUS >= frame.height) return null;
  const values = new Uint8Array(49);
  let i = 0;
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      values[i++] = frame.pixels[(y + dy) * frame.width + wrapPixel(x + dx, frame.width)];
    }
  }
  return values;
}

// Reject flat areas AND one-dimensional edges (the aperture/stripe ambiguity).
function texture(values: Uint8Array): number {
  let sum = 0, squares = 0, xx = 0, yy = 0, xy = 0;
  for (const value of values) { sum += value; squares += value * value; }
  if (squares / 49 - (sum / 49) ** 2 < 144) return 0;
  for (let y = 1; y < 6; y++) {
    for (let x = 1; x < 6; x++) {
      const i = y * 7 + x;
      const gx = (values[i + 1] - values[i - 1]) / 2, gy = (values[i + 7] - values[i - 7]) / 2;
      xx += gx * gx; yy += gy * gy; xy += gx * gy;
    }
  }
  const eigen = (xx + yy - Math.hypot(xx - yy, 2 * xy)) / 50;
  return eigen >= 25 ? eigen : 0;
}
function patchError(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}
function errorAt(template: Uint8Array, frame: GrayFrame, x: number, y: number): number {
  if (y - PATCH_RADIUS < 0 || y + PATCH_RADIUS >= frame.height) return Infinity;
  let i = 0, error = 0;
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      error += Math.abs(template[i++] - frame.pixels[(y + dy) * frame.width + wrapPixel(x + dx, frame.width)]);
    }
  }
  return error / 49;
}

type Match = { ok: true; dx: number; dy: number; quality: number } | { ok: false; reason: string };
function findMatch(template: Uint8Array, frame: GrayFrame, origin: Point): Match {
  let best = Infinity, bestX = 0, bestY = 0;
  const scores: { dx: number; dy: number; error: number }[] = [];
  for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
      const error = errorAt(template, frame, origin.x + dx, origin.y + dy);
      scores.push({ dx, dy, error });
      if (error < best) { best = error; bestX = dx; bestY = dy; }
    }
  }
  if (best > 14) return { ok: false, reason: '匹配质量不足，可能遮挡或运动超出范围' };
  let second = Infinity;
  for (const score of scores) {
    if (Math.max(Math.abs(score.dx - bestX), Math.abs(score.dy - bestY)) > 1) second = Math.min(second, score.error);
  }
  if (second - best < 5 || best > second * 0.75) return { ok: false, reason: '重复图案或最佳匹配不唯一' };
  if (Math.hypot(bestX, bestY) > MAX_STEP) return { ok: false, reason: '帧间运动过大，停止局部跟踪' };
  return { ok: true, dx: bestX, dy: bestY, quality: clamp((1 - best / 20) * Math.min(1, (second - best) / 25), 0, 1) };
}

/** Local grayscale template check, not optical flow or object re-detection. Point is normalized ERP. */
export function trackTemplatePoint(before: GrayFrame, after: GrayFrame, point: Point): Match {
  if (before.width !== after.width || before.height !== after.height) return { ok: false, reason: '灰度尺寸变化' };
  const origin = pixelPoint(before, point), template = patch(before, origin.x, origin.y);
  if (!template || !texture(template)) return { ok: false, reason: '内部纹理不足' };
  const forward = findMatch(template, after, origin);
  if (!forward.ok) return forward;
  const at = { x: wrapPixel(origin.x + forward.dx, after.width), y: origin.y + forward.dy };
  const nextTemplate = patch(after, at.x, at.y);
  if (!nextTemplate || !texture(nextTemplate)) return { ok: false, reason: '当前内部纹理不足或遮挡' };
  const backward = findMatch(nextTemplate, before, at);
  if (!backward.ok || Math.hypot(forward.dx + backward.dx, forward.dy + backward.dy) > 0.75) {
    return { ok: false, reason: '前后向匹配不一致，停止跟踪' };
  }
  return { ...forward, quality: Math.min(forward.quality, backward.quality) };
}

type Feature = { point: Point; anchor: Uint8Array };
type TrackState = {
  track: PanoramaTrack;
  anchorCenter: Point;
  shift: Point;
  features: Feature[];
  minimum: number;
};
function stop(state: TrackState, reason: string, status: 'lost' | 'unsupported' = 'lost'): void {
  Object.assign(state.track, { current: null, center: null, direction: 'unknown', status, reason, quality: 0, yaw: null, pitch: null });
  state.features = [];
}
const active = (state: TrackState) => state.track.status === 'waiting' || state.track.status === 'tracking';

function seedFeatures(frame: GrayFrame, view: Face, box: Box, heading: number): Feature[] {
  const candidates: { feature: Feature; score: number; u: number; v: number }[] = [];
  for (const v of [0.15, 0.325, 0.5, 0.675, 0.85]) {
    for (const u of [0.15, 0.325, 0.5, 0.675, 0.85]) {
      const projected = projectFacePoint(view, box[0] + (box[2] - box[0]) * u, box[1] + (box[3] - box[1]) * v, heading);
      const pixel = pixelPoint(frame, projected);
      const point = { x: pixel.x / frame.width, y: pixel.y / frame.height };
      let inside = true;
      // Every template sample must belong to this target's face-local box, not surrounding scenery.
      for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS && inside; dy++) {
        for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
          if (!inFaceBox({ x: wrapX(point.x + dx / frame.width), y: point.y + dy / frame.height }, view, box, heading)) {
            inside = false; break;
          }
        }
      }
      const values = inside ? patch(frame, pixel.x, pixel.y) : null;
      const score = values ? texture(values) : 0;
      if (values && score > 0) candidates.push({ feature: { point, anchor: values }, score, u, v });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (selected.every(other => Math.hypot(
      wrappedDelta(candidate.feature.point.x, other.feature.point.x) * frame.width,
      (candidate.feature.point.y - other.feature.point.y) * frame.height) >= 6)) selected.push(candidate);
    if (selected.length >= MAX_POINTS) break;
  }
  if (selected.length < MIN_POINTS ||
      Math.max(...selected.map(p => p.u)) - Math.min(...selected.map(p => p.u)) < 0.35 ||
      Math.max(...selected.map(p => p.v)) - Math.min(...selected.map(p => p.v)) < 0.35) return [];
  return selected.map(candidate => candidate.feature);
}

function createState(event: Event, id: number, heading: number, anchor?: GrayFrame): TrackState {
  const state: TrackState = {
    track: { id, label: event.text, original: [], current: null, center: null, originalDirection: event.direction,
      direction: 'unknown', status: 'waiting', reason: '等待下一真实帧验证匹配质量', quality: 0, yaw: null, pitch: null },
    anchorCenter: { x: 0, y: 0 }, shift: { x: 0, y: 0 }, features: [], minimum: MIN_POINTS,
  };
  const { view, box } = event;
  if (!view || !Object.hasOwn(FACES, view) || !box || box.length !== 4 || !box.every(Number.isFinite) ||
      box[0] < 0 || box[1] < 0 || box[2] > 1000 || box[3] > 1000 || box[0] >= box[2] || box[1] >= box[3] || !Number.isFinite(heading)) {
    stop(state, '缺少有效面内框、面名或全景参考角度，不支持跟踪', 'unsupported'); return state;
  }
  state.track.original = projectFaceBox(view, box, heading);
  state.anchorCenter = projectFacePoint(view, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2, heading);
  if (polar(state.anchorCenter) || state.track.original.some(polar) ||
      ((view === 'up' || view === 'down') && box[0] <= 500 && box[2] >= 500 && box[1] <= 500 && box[3] >= 500)) {
    stop(state, '目标靠近极区，平移近似不适用', 'unsupported'); return state;
  }
  if (!anchor) { stop(state, '历史中缺少指定锚帧或锚帧已过期，未用其他帧替代'); return state; }
  state.features = seedFeatures(anchor, view, box, heading);
  if (state.features.length < MIN_POINTS) { stop(state, '目标内部纹理点不足或分布不足'); return state; }
  state.minimum = Math.max(MIN_POINTS, Math.ceil(state.features.length * 0.8));
  return state;
}

function nearTarget(point: Point, state: TrackState): boolean {
  const center = { x: wrapX(state.anchorCenter.x + state.shift.x), y: state.anchorCenter.y + state.shift.y };
  const xs = state.track.original.map(p => wrappedDelta(p.x, state.anchorCenter.x));
  const ys = state.track.original.map(p => p.y + state.shift.y);
  const dx = wrappedDelta(point.x, center.x), margin = (SEARCH_RADIUS + PATCH_RADIUS + 1);
  return dx >= Math.min(...xs) - margin / WIDTH && dx <= Math.max(...xs) + margin / WIDTH &&
    point.y >= Math.min(...ys) - margin / HEIGHT && point.y <= Math.max(...ys) + margin / HEIGHT;
}

// Distributed background samples only veto tracking. They never estimate/compensate a camera pose.
function backgroundChange(before: GrayFrame, after: GrayFrame, states: TrackState[]): string | null {
  let count = 0, changed = 0;
  const columns = new Set<number>(), rows = new Set<number>();
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 8; col++) {
      const point = { x: (col + 0.5) / 8, y: 0.2 + row * 0.2 };
      if (states.some(state => nearTarget(point, state))) continue;
      const at = pixelPoint(before, point), a = patch(before, at.x, at.y), b = patch(after, at.x, at.y);
      if (!a || !b || !texture(a)) continue;
      count++; columns.add(Math.floor(col / 2)); rows.add(Math.floor(row / 2));
      if (patchError(a, b) > 18) changed++;
    }
  }
  if (count < 8 || columns.size < 3 || rows.size < 2) return '分布背景纹理不足，无法保守验证画面连续性';
  if (changed >= Math.max(4, Math.ceil(count * 0.3))) return '背景分布点大范围变化或切镜，未补偿相机运动';
  return null;
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function advanceTrack(state: TrackState, before: GrayFrame, after: GrayFrame, heading: number): void {
  const matches: { feature: Feature; dx: number; dy: number; quality: number }[] = [];
  let failure = '多点匹配不足，可能遮挡';
  for (const feature of state.features) {
    const match = trackTemplatePoint(before, after, feature.point);
    if (!match.ok) { failure = match.reason; continue; }
    const point = { x: wrapX(feature.point.x + match.dx / WIDTH), y: feature.point.y + match.dy / HEIGHT };
    const at = pixelPoint(after, point), values = patch(after, at.x, at.y);
    if (!values || patchError(feature.anchor, values) > 18) { failure = '与锚帧内部纹理不一致，停止漂移'; continue; }
    matches.push({ feature: { point, anchor: feature.anchor }, dx: match.dx, dy: match.dy, quality: match.quality });
  }
  if (matches.length < state.minimum) { stop(state, failure); return; }
  const dx = median(matches.map(m => m.dx)), dy = median(matches.map(m => m.dy));
  const inliers = matches.filter(m => Math.hypot(m.dx - dx, m.dy - dy) <= 0.75);
  if (inliers.length < state.minimum) { stop(state, '目标内部多点位移不一致，停止跟踪'); return; }
  state.shift.x += dx / WIDTH; state.shift.y += dy / HEIGHT;
  const current = state.track.original.map(p => ({ x: wrapX(p.x + state.shift.x), y: p.y + state.shift.y }));
  const center = { x: wrapX(state.anchorCenter.x + state.shift.x), y: state.anchorCenter.y + state.shift.y };
  if (polar(center) || current.some(polar)) { stop(state, '当前轮廓进入极区，平移近似不适用'); return; }
  const retainedFraction = inliers.length / state.features.length;
  state.features = inliers.map(m => m.feature); // Never seed replacement points after a mismatch.
  const yaw = (center.x - 0.5) * 360, pitch = (0.5 - center.y) * 180;
  // yaw is ERP-relative. Direction uses the FIXED result heading, not a tracked user orientation.
  const relativeYaw = wrappedDelta(center.x, wrapX(0.5 + heading / 360)) * 360;
  Object.assign(state.track, { current, center, yaw, pitch, direction: direction(relativeYaw, pitch), status: 'tracking',
    reason: '内部多点一致平移，仅为轮廓近似；匹配质量不是概率',
    quality: Math.min(...inliers.map(m => m.quality)) * retainedFraction });
}

/** Bounded real-frame replay and local translation only; no prediction, range, speech, or reacquisition. */
export class PanoramaTracker {
  private history: GrayFrame[] = [];
  private states: TrackState[] = [];
  private meta: { frameId: number; capturedAt: number; heading: number } | null = null;
  private lastId = -1;
  private lastAt = -1;
  private sourceWidth = 0;
  private sourceHeight = 0;

  private snapshot(message?: string): TrackingSnapshot {
    const tracking = this.states.filter(state => state.track.status === 'tracking').length;
    const waiting = this.states.some(state => state.track.status === 'waiting');
    return {
      // This is the analysis frameId, not the latest gray-frame ID. observedAt identifies playback time.
      frameId: this.meta?.frameId ?? -1, capturedAt: this.meta?.capturedAt ?? 0,
      observedAt: this.lastAt >= 0 ? this.lastAt : (this.meta?.capturedAt ?? 0), historyFrames: this.history.length,
      tracks: this.states.map(({ track }) => ({ ...track, original: track.original.map(p => ({ ...p })),
        current: track.current?.map(p => ({ ...p })) ?? null, center: track.center ? { ...track.center } : null })),
      message: message ?? (this.states.length === 0 ? '本次结果没有可跟踪目标' : tracking > 0
        ? `已回放真实帧，${tracking}个目标通过局部平移验证；匹配质量不是概率`
        : waiting ? '已找到指定锚帧，等待下一真实帧验证，尚未跟踪成功' : '没有通过跟踪验证的目标，请查看各目标原因'),
    };
  }
  private loseActive(reason: string): void {
    for (const state of this.states) if (active(state)) stop(state, reason);
  }
  private step(before: GrayFrame, after: GrayFrame): void {
    const states = this.states.filter(active);
    if (!states.length) return;
    if (after.at - before.at > MAX_GAP_MS || after.at <= before.at) {
      this.loseActive('真实帧间隔超过600毫秒或时间无序，停止跟踪'); return;
    }
    const changed = backgroundChange(before, after, states);
    if (changed) { this.loseActive(changed); return; }
    for (const state of states) advanceTrack(state, before, after, this.meta!.heading);
  }
  addFrame(frame: GrayFrame): TrackingSnapshot | null {
    let invalid = '';
    if (!Number.isSafeInteger(frame.id) || frame.id < 0 || frame.id <= this.lastId) invalid = '帧编号未严格递增，拒绝该帧并停止旧轨迹';
    else if (!Number.isFinite(frame.at) || frame.at < 0 || frame.at <= this.lastAt) invalid = '帧时间无效或未递增，停止旧轨迹';
    else if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 32 ||
      frame.width > 4096 || frame.height < 16 || frame.width !== frame.height * 2 ||
      !(frame.pixels instanceof Uint8Array) || frame.pixels.length !== frame.width * frame.height) invalid = '灰度帧尺寸或数据无效，要求2比1全景';
    if (invalid) {
      this.loseActive(invalid); this.history = [];
      return this.meta ? this.snapshot(invalid) : null;
    }
    const resized = this.sourceWidth > 0 && (frame.width !== this.sourceWidth || frame.height !== this.sourceHeight);
    if (resized) { this.loseActive('输入灰度尺寸变化，旧轨迹已丢失'); this.history = []; }
    this.sourceWidth = frame.width; this.sourceHeight = frame.height;
    // Own exactly 320x160 bytes/frame; never retain a caller buffer or an unbounded source-size frame.
    const pixels = new Uint8Array(WIDTH * HEIGHT);
    if (frame.width === WIDTH && frame.height === HEIGHT) pixels.set(frame.pixels);
    else {
      for (let y = 0; y < HEIGHT; y++) {
        const sy = Math.min(frame.height - 1, Math.floor((y + 0.5) * frame.height / HEIGHT));
        for (let x = 0; x < WIDTH; x++) {
          const sx = Math.min(frame.width - 1, Math.floor((x + 0.5) * frame.width / WIDTH));
          pixels[y * WIDTH + x] = frame.pixels[sy * frame.width + sx];
        }
      }
    }
    const next = { id: frame.id, at: frame.at, width: WIDTH, height: HEIGHT, pixels };
    const previous = this.history.at(-1);
    this.lastId = frame.id; this.lastAt = frame.at;
    this.history.push(next);
    while (this.history.length > MAX_HISTORY || next.at - this.history[0].at > HISTORY_MS) this.history.shift();
    if (this.meta && next.at - this.meta.capturedAt > HISTORY_MS) this.loseActive('识别锚帧已超过16秒，停止沿用旧语义');
    if (previous) this.step(previous, next);
    return this.meta ? this.snapshot(resized ? '输入尺寸变化，历史已重置且旧轨迹已丢失' : undefined) : null;
  }
  resolve(input: ResultInput): TrackingSnapshot {
    if (this.meta && input.frameId <= this.meta.frameId) return this.snapshot('已忽略重复或过期结果，不重新认领目标');
    this.meta = { frameId: input.frameId, capturedAt: input.capturedAt, heading: input.heading };
    const index = this.history.findIndex(frame => frame.id === input.anchorId);
    const anchor = index >= 0 ? this.history[index] : undefined;
    this.states = input.events.slice(0, 6).map((event, id) => createState(event, id, input.heading, anchor));
    if (index >= 0) {
      // Replay every retained real frame from this exact anchor, including all continuity vetoes.
      for (let i = index + 1; i < this.history.length; i++) this.step(this.history[i - 1], this.history[i]);
    }
    return this.snapshot(input.events.length === 0 ? '本次结果没有可跟踪目标' : !anchor
      ? '指定锚帧不存在或已过期，无法回放，未用最近帧替代' : undefined);
  }
}
