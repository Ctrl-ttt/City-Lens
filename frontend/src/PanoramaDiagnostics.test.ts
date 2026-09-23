import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PanoramaOverlay } from './PanoramaDiagnostics';
import { projectFaceBox, type PanoramaTrack, type TrackingSnapshot } from './panoramaTracking';

const original = projectFaceBox('front', [300, 300, 700, 700]);
const track: PanoramaTrack = {
  id: 0, label: '自行车', original,
  current: original.map(point => ({ ...point, x: point.x + .04 })), center: { x: .54, y: .5 },
  originalDirection: 'front', direction: 'front', status: 'tracking', reason: '', quality: 1, yaw: 14.4, pitch: 0,
};
function render(overrides: Partial<PanoramaTrack> = {}, fresh = true) {
  const snapshot: TrackingSnapshot = {
    frameId: 1, capturedAt: 1000, observedAt: 1500, historyFrames: 4,
    tracks: [{ ...track, ...overrides }], message: '',
  };
  return renderToStaticMarkup(createElement(PanoramaOverlay, { snapshot, fresh, aspect: 2 }));
}

describe('全景框名称', () => {
  it('给原框和跟踪框显示相同编号与中文物体名，并区分状态', () => {
    const markup = render();
    expect(markup).toContain('1. 自行车 · 识别时');
    expect(markup).toContain('1. 自行车 · 跟踪');
    expect(markup.match(/class="tracking-label tracking-label-original"/g)).toHaveLength(1);
    expect(markup.match(/class="tracking-label tracking-label-current"/g)).toHaveLength(1);
  });

  it.each(['lost', 'waiting', 'unsupported'] as const)('%s 时只保留注明识别时的名称', status => {
    const markup = render({ status });
    expect(markup).toContain('1. 自行车 · 识别时');
    expect(markup).not.toContain('tracking-label-current');
    expect(markup).not.toContain(' · 跟踪');
  });

  it('观测过时后不再显示当前名称', () => {
    const markup = render({}, false);
    expect(markup).toContain('1. 自行车 · 识别时');
    expect(markup).not.toContain('tracking-label-current');
  });

  it('没有有效轮廓时不凭空标出物体位置', () => {
    expect(render({ original: [], current: null, center: null, status: 'unsupported' })).not.toContain('tracking-label');
  });

  it('跨全景接缝的两侧都显示完整名称', () => {
    const seam = projectFaceBox('back', [300, 300, 700, 700]);
    const markup = render({ original: seam, current: seam, center: { x: 0, y: .5 } });
    expect(markup.match(/1\. 自行车 · 识别时/g)).toHaveLength(2);
    expect(markup.match(/1\. 自行车 · 跟踪/g)).toHaveLength(2);
  });

  it.each([
    { x: .001, y: .001 }, { x: .95, y: .001 }, { x: .001, y: .95 }, { x: .95, y: .95 },
  ])('边界附近的名称底板保持在画面内 %s', ({ x, y }) => {
    const points = [{ x, y }, { x: x + .04, y }, { x: x + .04, y: y + .04 }, { x, y: y + .04 }, { x, y }];
    const markup = render({ original: points, current: points });
    const labels = [...markup.matchAll(/class="tracking-label tracking-label-\w+" transform="translate\(([^ ]+) ([^)]+)\)"><rect width="([^"]+)" height="([^"]+)"/g)];
    expect(labels).toHaveLength(2);
    for (const [, left, top, width, height] of labels) {
      expect(Number(left)).toBeGreaterThanOrEqual(0);
      expect(Number(top)).toBeGreaterThanOrEqual(0);
      expect(Number(left) + Number(width)).toBeLessThanOrEqual(1000);
      expect(Number(top) + Number(height)).toBeLessThanOrEqual(500);
    }
  });

  it('名称按文本转义，不插入可执行标记', () => {
    const markup = render({ label: '<script>alert(1)</script>' });
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
  });
});
