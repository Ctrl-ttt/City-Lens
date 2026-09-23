import { describe, expect, it } from 'vitest';
import { directionFromBox, estimateLocalProximity, FrameHistory, isApparentApproach, rewriteSpeechForMotion, trackBox, trackTrajectory, type GrayFrame } from './motion';

function frame(shiftX = 0, shiftY = 0): GrayFrame {
  const width = 80, height = 60, pixels = new Uint8ClampedArray(width * height).fill(218);
  for (let y = 18 + shiftY; y < 42 + shiftY; y++) for (let x = 24 + shiftX; x < 52 + shiftX; x++)
    if (x >= 0 && x < width && y >= 0 && y < height) pixels[y * width + x] = ((x - shiftX) * 19 + (y - shiftY) * 13) % 160 + 25;
  return { width, height, pixels };
}

describe('stale-result motion compensation', () => {
  it('moves a textured target to its newest matching position', () => {
    const match = trackBox(frame(), frame(6, -4), [300, 300, 650, 700]);
    expect(match).not.toBeNull();
    expect(match!.dx).toBe(6);
    expect(match!.dy).toBe(-4);
    expect(match!.box).toEqual([375, 233, 725, 633]);
  });

  it('rejects a flat or changed scene instead of inventing a trajectory', () => {
    const flat: GrayFrame = { width: 80, height: 60, pixels: new Uint8ClampedArray(4800).fill(100) };
    expect(trackBox(flat, flat, [300, 300, 650, 700])).toBeNull();
    expect(trackBox(frame(), flat, [300, 300, 650, 700])).toBeNull();
  });

  it('replays actual intermediate frames and predicts only a short future direction', () => {
    const trajectory = trackTrajectory(frame(), [300, 300, 650, 700], 0, [
      { at: 500, image: frame(2) }, { at: 1000, image: frame(4) }, { at: 1500, image: frame(6) },
    ], 2.5);
    expect(trajectory).not.toBeNull();
    expect(trajectory!.box).toEqual([375, 300, 725, 700]);
    expect(trajectory!.velocityX).toBeCloseTo(50, 1);
    expect(trajectory!.predictedBox).toEqual([500, 300, 850, 700]);
    expect(directionFromBox(trajectory!.predictedBox, 'front')).toBe('right');
  });

  it('bounds frame history and keeps direction thresholds stable', () => {
    const history = new FrameHistory(1000, 300);
    history.add(0, frame()); history.add(100, frame(1)); history.add(400, frame(2)); history.add(1500, frame(3));
    expect(history.size).toBe(1);
    expect(history.after(1000)).toHaveLength(1);
    expect(directionFromBox([200, 100, 600, 500], 'left')).toBe('left');
    expect(directionFromBox([200, 100, 600, 500], 'front')).toBe('front');
  });

  it('derives only coarse local proximity bands from a complete current box', () => {
    expect(estimateLocalProximity('person', [300, 100, 700, 950], 16 / 9, 75)).toBe('near');
    expect(estimateLocalProximity('person', [300, 200, 700, 500], 16 / 9, 75)).toBe('far');
    expect(estimateLocalProximity('crosswalk', [100, 100, 900, 900], 16 / 9, 75)).toBe('unknown');
  });

  it('requires stable local scale growth before declaring apparent approach', () => {
    expect(isApparentApproach([{ at: 0, size: 100 }, { at: 400, size: 104 }, { at: 800, size: 109 }, { at: 1200, size: 114 }])).toBe(true);
    expect(isApparentApproach([{ at: 0, size: 100 }, { at: 400, size: 120 }, { at: 800, size: 95 }, { at: 1200, size: 130 }])).toBe(false);
  });

  it('rewrites the selected cloud speech with the predicted local direction and approach', () => {
    const speech = rewriteSpeechForMotion(
      { key: 'bicycle:front:near', priority: 'high', text: '前方发现自行车' },
      [{ category: 'obstacle', label: 'bicycle', text: '自行车', original_direction: 'front', direction: 'right', approaching: true }],
      { left: '左侧', front: '前方', right: '右侧', back: '后方', above: '上方', unknown: '画面中' },
    );
    expect(speech).toEqual({ key: 'bicycle:right:approaching', priority: 'urgent', text: '右侧自行车疑似正在靠近，请注意' });
  });
});
