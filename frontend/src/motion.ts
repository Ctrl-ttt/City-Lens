export type GrayFrame = { width: number; height: number; pixels: Uint8ClampedArray };
export type MotionMatch = { box: [number, number, number, number]; dx: number; dy: number; confidence: number };
export type TimedFrame = { at: number; image: GrayFrame };
export type Trajectory = {
  box: [number, number, number, number];
  predictedBox: [number, number, number, number];
  velocityX: number;
  velocityY: number;
  samples: number;
  confidence: number;
  forecastSeconds: number;
  approaching: boolean;
  approachRate: number | null;
  speedLevel: 'unknown' | 'slow' | 'medium' | 'fast';
};

export function isApparentApproach(points: readonly { at: number; size: number }[]) {
  const recent = points.slice(-5);
  if (recent.length < 4 || (recent.at(-1)!.at - recent[0].at) / 1000 < 1) return false;
  return recent.slice(1).every((point, index) => point.size >= recent[index].size * .98)
    && recent.at(-1)!.size >= recent[0].size * 1.12;
}

const TRACK_LONG_SIDE = 192;

/**
 * A deliberately small, browser-only tracker.  It follows a labelled region from
 * the sent frame to the newest decoded frame; it does not estimate metric depth,
 * user location, or collision time.
 */
export function snapshotVideo(video: HTMLVideoElement, flipHorizontal: boolean): GrayFrame | null {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(1, TRACK_LONG_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    if (flipHorizontal) context.setTransform(-1, 0, 0, 1, width, 0);
    context.drawImage(video, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    const pixels = new Uint8ClampedArray(width * height);
    for (let source = 0, target = 0; source < rgba.length; source += 4, target++)
      pixels[target] = (77 * rgba[source] + 150 * rgba[source + 1] + 29 * rgba[source + 2]) >> 8;
    return { width, height, pixels };
  } catch { return null; }
  finally { canvas.width = canvas.height = 0; }
}

const at = (frame: GrayFrame, x: number, y: number) => frame.pixels[y * frame.width + x];
const clip = (value: number, lower: number, upper: number) => Math.max(lower, Math.min(upper, value));

/** A bounded, memory-only video history. Frames are never serialized or uploaded. */
export class FrameHistory {
  private frames: TimedFrame[] = [];
  constructor(private maxAgeMs = 15000, private minIntervalMs = 350) {}
  add(at: number, image: GrayFrame | null) {
    if (!image || !Number.isFinite(at)) return;
    const last = this.frames.at(-1);
    if (last && at <= last.at) return;
    if (last && at - last.at < this.minIntervalMs) return;
    this.frames.push({ at, image });
    while (this.frames.length && this.frames[0].at < at - this.maxAgeMs) this.frames.shift();
  }
  after(at: number, until = Infinity) { return this.frames.filter(frame => frame.at > at && frame.at <= until); }
  clear() { this.frames = []; }
  get size() { return this.frames.length; }
}

/**
 * Match the event's patch in the newest image.  A local match follows an object
 * through either subject motion or camera motion, while ambiguity and a scene cut
 * return null.  Coordinates are normalized to the model's 0..1000 box format.
 */
export function trackBox(before: GrayFrame, after: GrayFrame, box: readonly number[]): MotionMatch | null {
  if (box.length !== 4 || before.width !== after.width || before.height !== after.height) return null;
  const [rawX1, rawY1, rawX2, rawY2] = box;
  if (![rawX1, rawY1, rawX2, rawY2].every(Number.isFinite) || rawX2 <= rawX1 || rawY2 <= rawY1) return null;
  const x1 = clip(Math.floor(rawX1 / 1000 * before.width), 0, before.width - 1);
  const y1 = clip(Math.floor(rawY1 / 1000 * before.height), 0, before.height - 1);
  const x2 = clip(Math.ceil(rawX2 / 1000 * before.width), x1 + 1, before.width);
  const y2 = clip(Math.ceil(rawY2 / 1000 * before.height), y1 + 1, before.height);
  const patchW = x2 - x1, patchH = y2 - y1;
  if (patchW < 8 || patchH < 8) return null;

  // Include a little border so edges remain trackable even when the object itself
  // has a flat colour.  The search range is deliberately bounded: a far jump is a
  // changed view, not a trustworthy continuation of this target.
  const pad = Math.max(1, Math.floor(Math.min(patchW, patchH) * 0.14));
  const left = Math.max(0, x1 - pad), top = Math.max(0, y1 - pad);
  const right = Math.min(before.width, x2 + pad), bottom = Math.min(before.height, y2 + pad);
  const step = Math.max(1, Math.ceil(Math.min(right - left, bottom - top) / 14));
  const samples: Array<[number, number, number]> = [];
  let sum = 0, sumSquares = 0;
  for (let y = top; y < bottom; y += step) for (let x = left; x < right; x += step) {
    const value = at(before, x, y); samples.push([x, y, value]); sum += value; sumSquares += value * value;
  }
  if (samples.length < 30) return null;
  const variance = sumSquares / samples.length - (sum / samples.length) ** 2;
  if (variance < 70) return null; // Flat patches cannot establish a reliable direction.

  const rangeX = Math.min(24, Math.max(4, Math.floor(patchW * 0.55)));
  const rangeY = Math.min(24, Math.max(4, Math.floor(patchH * 0.55)));
  let best = Infinity, runnerUp = Infinity, bestDx = 0, bestDy = 0;
  for (let dy = -rangeY; dy <= rangeY; dy++) for (let dx = -rangeX; dx <= rangeX; dx++) {
    if (left + dx < 0 || top + dy < 0 || right + dx > after.width || bottom + dy > after.height) continue;
    let currentSum = 0;
    for (const [x, y] of samples) currentSum += at(after, x + dx, y + dy);
    const brightnessOffset = currentSum / samples.length - sum / samples.length;
    let error = 0;
    for (const [x, y, value] of samples) error += Math.abs(value + brightnessOffset - at(after, x + dx, y + dy));
    error /= samples.length;
    if (error < best) { runnerUp = best; best = error; bestDx = dx; bestDy = dy; }
    else if (error < runnerUp) runnerUp = error;
  }
  // A non-unique location (repeating tiles, a panorama turn, or blur) is rejected.
  if (!Number.isFinite(best) || best > 35 || runnerUp - best < 0.8) return null;
  const confidence = Math.round(clip((runnerUp - best) / 12, 0, 1) * 100) / 100;
  const shifted: [number, number, number, number] = [
    Math.round(clip(rawX1 + bestDx / before.width * 1000, 0, 999)),
    Math.round(clip(rawY1 + bestDy / before.height * 1000, 0, 999)),
    Math.round(clip(rawX2 + bestDx / before.width * 1000, 1, 1000)),
    Math.round(clip(rawY2 + bestDy / before.height * 1000, 1, 1000)),
  ];
  if (shifted[2] <= shifted[0] || shifted[3] <= shifted[1]) return null;
  return { box: shifted, dx: bestDx, dy: bestDy, confidence };
}

const centerOf = (box: readonly number[]) => ({ x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 });

/** Replay actual intervening frames, then forecast only the short speech/reaction interval. */
export function trackTrajectory(reference: GrayFrame, initialBox: readonly number[], capturedAt: number,
                                frames: readonly TimedFrame[], forecastSeconds = 2.5): Trajectory | null {
  if (!Number.isFinite(capturedAt) || !frames.length) return null;
  let previous = reference;
  let box: [number, number, number, number] = [...initialBox] as [number, number, number, number];
  const points = [{ at: capturedAt, ...centerOf(box), size: box[3] - box[1] }];
  let confidence = 1;
  for (const frame of frames.slice(0, 30)) {
    if (frame.at <= points.at(-1)!.at || frame.image.width !== previous.width || frame.image.height !== previous.height) continue;
    // A long missing interval no longer represents continuous local tracking.
    if (frame.at - points.at(-1)!.at > 1500) return null;
    const match = trackBox(previous, frame.image, box);
    if (!match) return null;
    box = match.box; previous = frame.image; confidence = Math.min(confidence, match.confidence);
    points.push({ at: frame.at, ...centerOf(box), size: box[3] - box[1] });
  }
  if (points.length < 2) return null;
  const recent = points.slice(-6);
  const meanT = recent.reduce((sum, point) => sum + point.at, 0) / recent.length;
  const denominator = recent.reduce((sum, point) => sum + (point.at - meanT) ** 2, 0);
  const slope = (axis: 'x' | 'y') => denominator > 250000
    ? recent.reduce((sum, point) => sum + (point.at - meanT) * point[axis], 0) / denominator * 1000 : 0;
  const velocityX = clip(slope('x'), -220, 220);
  const velocityY = clip(slope('y'), -220, 220);
  const scalePoints = points.slice(-5);
  const scaleSpan = (scalePoints.at(-1)!.at - scalePoints[0].at) / 1000;
  const rawRate = scaleSpan >= 1 ? ((scalePoints.at(-1)!.size / scalePoints[0].size) ** (1 / scaleSpan) - 1) * 100 : NaN;
  const approachRate = Number.isFinite(rawRate) && rawRate > 0 ? Math.round(rawRate * 1000) / 1000 : null;
  const speedLevel = approachRate === null || approachRate <= 3 ? 'unknown' : approachRate <= 10 ? 'slow' : approachRate <= 25 ? 'medium' : 'fast';
  const approaching = isApparentApproach(points);
  const horizon = clip(forecastSeconds, 0, 5);
  const shiftX = clip(velocityX * horizon, -220, 220);
  const shiftY = clip(velocityY * horizon, -220, 220);
  const predictedBox: [number, number, number, number] = [
    Math.round(clip(box[0] + shiftX, 0, 999)), Math.round(clip(box[1] + shiftY, 0, 999)),
    Math.round(clip(box[2] + shiftX, 1, 1000)), Math.round(clip(box[3] + shiftY, 1, 1000)),
  ];
  if (predictedBox[2] <= predictedBox[0] || predictedBox[3] <= predictedBox[1]) return null;
  return { box, predictedBox, velocityX, velocityY, samples: points.length, confidence, forecastSeconds: horizon,
    approaching, approachRate, speedLevel };
}

export type LocalDirection = 'left' | 'front' | 'right' | 'back' | 'above' | 'unknown';

/** Horizontal direction with hysteresis so a target near a boundary does not chatter. */
export function directionFromBox(box: readonly number[], previous: LocalDirection): LocalDirection {
  const x = (box[0] + box[2]) / 2;
  if (previous === 'left' && x < 420) return 'left';
  if (previous === 'right' && x > 580) return 'right';
  if (x < 350) return 'left';
  if (x > 650) return 'right';
  return 'front';
}

const TYPICAL_HEIGHT_M: Record<string, number> = {
  person: 1.65, car: 1.5, motorcycle: 1.1, barrier: 1.5, bollard: .9,
  obstacle: .8, step: .15, stairs: 1.2, elevator: 2.2, escalator: 1.6, entrance: 2.2, bus_stop: 2.6,
};

/** Coarse monocular band from the newest local box; never expose the metre estimate. */
export function estimateLocalProximity(label: string, box: readonly number[], aspectRatio: number, hfovDeg = 75) {
  const height = TYPICAL_HEIGHT_M[label];
  const boxFraction = (box[3] - box[1]) / 1000;
  if (!height || box[1] <= 5 || box[3] >= 995 || boxFraction <= 0 || !(aspectRatio > 0) || !(hfovDeg > 0 && hfovDeg < 170)) return 'unknown' as const;
  const distance = height * aspectRatio / (2 * Math.tan(hfovDeg * Math.PI / 360) * boxFraction);
  return distance <= 2.5 ? 'near' as const : distance <= 5 ? 'mid' as const : 'far' as const;
}

/** Keep semantic wording from the backend, changing only locally observed direction/approach. */
export function rewriteSpeechForMotion(speech: Speech, events: readonly Event[], names: Record<LocalDirection, string>): Speech {
  const keys = speech.key.split('|'), phrases = speech.text.split('；');
  if (keys.length !== phrases.length) return speech;
  let urgent = false, changed = false;
  const rewrittenKeys: string[] = [];
  const rewrittenPhrases = keys.map((key, index) => {
    const baseKey = key.replace(/:(?:approaching|near)$/, '');
    const event = events.find(item => item.original_direction && baseKey === `${item.label}:${item.original_direction}`);
    if (!event) { rewrittenKeys.push(key); return phrases[index]; }
    const directionChanged = event.direction !== event.original_direction;
    const approachChanged = !!event.approaching && !key.endsWith(':approaching');
    if (!directionChanged && !approachChanged) { rewrittenKeys.push(key); return phrases[index]; }
    changed = true;
    let rewrittenKey = key.replace(`${event.label}:${event.original_direction}`, `${event.label}:${event.direction}`);
    const oldPrefix = names[event.original_direction!], newPrefix = names[event.direction];
    let phrase = phrases[index].startsWith(oldPrefix) ? newPrefix + phrases[index].slice(oldPrefix.length) : phrases[index];
    if (approachChanged) {
      urgent = true;
      rewrittenKey = `${event.label}:${event.direction}:approaching`;
      phrase = `${newPrefix}${event.text}疑似正在靠近，请注意`;
    }
    rewrittenKeys.push(rewrittenKey);
    return phrase;
  });
  return changed ? { ...speech, key: rewrittenKeys.join('|'), text: rewrittenPhrases.join('；'), priority: urgent ? 'urgent' : speech.priority } : speech;
}
import type { Event, Speech } from './types';
