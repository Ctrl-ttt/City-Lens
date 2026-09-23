import { useEffect, useRef, useState } from 'react';
import type { Point, PanoramaTrack, TrackingSnapshot } from './panoramaTracking';

const directions = { left: '左侧', front: '前方', right: '右侧', back: '后方', above: '上方', unknown: '未确认' };
const states = { tracking: '连续匹配', lost: '跟踪失效', unsupported: '暂不支持', waiting: '等待连续帧' };

export function useTrackingFreshness(snapshot: TrackingSnapshot | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!snapshot) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 150);
    return () => clearInterval(timer);
  }, [snapshot]);
  const age = snapshot ? Math.max(0, now - snapshot.observedAt) : 0;
  return { age, fresh: !!snapshot && age <= 600 };
}

function outline(points: Point[], offset: number, height: number) {
  let previous = points[0]?.x ?? 0;
  return points.map((point, i) => {
    const x = point.x + Math.round(previous - point.x);
    previous = x;
    return `${i ? 'L' : 'M'}${(x + offset) * 1000},${point.y * height}`;
  }).join(' ');
}

function OutlineLabel({ points, name, kind, height, unitsPerPixel }: {
  points: Point[]; name: string; kind: 'original' | 'current'; height: number; unitsPerPixel: number;
}) {
  if (!points.length) return null;
  let previous = points[0].x;
  const xs = points.map(point => {
    previous = point.x + Math.round(previous - point.x);
    return previous;
  });
  const left = Math.min(...xs), right = Math.max(...xs);
  const top = Math.min(...points.map(point => point.y)) * height;
  const bottom = Math.max(...points.map(point => point.y)) * height;
  const text = `${name} · ${kind === 'current' ? '跟踪' : '识别时'}`;
  const fontSize = 14 * unitsPerPixel, padding = 4 * unitsPerPixel;
  const width = Math.min(1000 - padding * 2, Array.from(text).length * fontSize + padding * 2);
  const labelHeight = fontSize + padding * 2;
  const y = Math.max(padding, Math.min(height - labelHeight - padding,
    kind === 'current' ? top - labelHeight - padding : bottom + padding));
  return <>{[-1, 0, 1].map(offset => {
    const start = Math.max(0, left + offset), end = Math.min(1, right + offset);
    if (start >= end) return null;
    const x = Math.max(padding, Math.min(1000 - width - padding, (start + end) * 500 - width / 2));
    return <g className={`tracking-label tracking-label-${kind}`} key={offset} transform={`translate(${x} ${y})`}>
      <rect width={width} height={labelHeight} rx={padding} />
      <text x={padding} y={padding + fontSize * 0.82} fontSize={fontSize}>{text}</text>
    </g>;
  })}</>;
}

export function PanoramaOverlay({ snapshot, tracks, fresh, aspect }: { snapshot?: TrackingSnapshot; tracks?: PanoramaTrack[]; fresh: boolean; aspect: number }) {
  const svg = useRef<SVGSVGElement>(null);
  const [unitsPerPixel, setUnitsPerPixel] = useState(2);
  const height = 1000 / aspect;
  useEffect(() => {
    const resize = new ResizeObserver(([entry]) => {
      const width = Math.min(entry.contentRect.width, entry.contentRect.height * aspect);
      // SVG geometry scales with the video; names stay readable in CSS pixels.
      if (width > 0) setUnitsPerPixel(1000 / width);
    });
    resize.observe(svg.current!);
    return () => resize.disconnect();
  }, [aspect]);
  const items = tracks ?? snapshot?.tracks ?? [];
  return <svg ref={svg} className="panorama-overlay" viewBox={`0 0 1000 ${height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    {items.map(track => <g key={track.id}>
      {[-1, 0, 1].map(offset => <g key={offset}>
        <path className="tracking-original" d={outline(track.original, offset, height)} />
        {fresh && track.status === 'tracking' && track.current && <path className="tracking-current" d={outline(track.current, offset, height)} />}
      </g>)}
    </g>)}
    {items.map(track => <g key={track.id}>
      <OutlineLabel points={track.original} name={`${track.id + 1}. ${track.label}`} kind="original" height={height} unitsPerPixel={unitsPerPixel} />
      {fresh && track.status === 'tracking' && track.current && <OutlineLabel points={track.current} name={`${track.id + 1}. ${track.label}`} kind="current" height={height} unitsPerPixel={unitsPerPixel} />}
    </g>)}
  </svg>;
}

export function PanoramaDiagnostics({ enabled, onToggle, snapshot, error, age, fresh, sample }: {
  enabled: boolean; onToggle: (enabled: boolean) => void; snapshot: TrackingSnapshot | null; error: string;
  age: number; fresh: boolean; sample: boolean;
}) {
  const matched = fresh ? snapshot?.tracks.filter(track => track.status === 'tracking').length ?? 0 : 0;
  return <section className="tracking-panel" aria-label="全景跟踪验证">
    <h3>全景跟踪验证 <span className="tag subtle">仅观察 · 不影响播报</span></h3>
    <label className="tracking-toggle"><input type="checkbox" checked={enabled} onChange={e => onToggle(e.target.checked)} />启用本地跟踪验证（不影响播报）</label>
    <p className="quiet-note">仅自动识别时采集，按键单帧不参与；最多缓存 16 秒低分辨率灰度帧，仅留浏览器内存，不落盘、不额外上传。暂停、看牌或切换输入会清空。</p>
    {enabled && <>
      {sample && <p className="quiet-note">当前为固定样例：目标类别和初始框不来自真实识别，匹配结果仅供联调。</p>}
      <p className="tracking-summary">{error || (snapshot ? snapshot.message : '等待下一次全景环境识别；暂停的单帧不能验证连续跟踪。')}</p>
      {snapshot && <>
        <p className="tracking-count">第 {snapshot.frameId} 帧 · 连续匹配 {matched}/{snapshot.tracks.length} · 缓存 {snapshot.historyFrames} 帧</p>
        <p className="quiet-note">已观测跨度 {Math.max(0, (snapshot.observedAt - snapshot.capturedAt) / 1000).toFixed(1)} 秒 · 最近观测距今 {(age / 1000).toFixed(1)} 秒{!fresh && ' · 当前标记已隐藏，等待新画面'}</p>
        <ol className="tracking-list">{snapshot.tracks.map(track => <li key={track.id}>
          <strong>{track.id + 1}. {track.label}</strong>
          <span>{track.status === 'tracking' && !fresh ? '观测已过时' : states[track.status]} · {track.reason}</span>
          <span>原方向：{directions[track.originalDirection]} → 当前：{fresh && track.status === 'tracking' ? directions[track.direction] : '未确认'}</span>
          {fresh && track.status === 'tracking' && <span>匹配质量 {Math.round(track.quality * 100)}/100（不是正确率） · 全景水平角 {track.yaw?.toFixed(1)}°</span>}
        </li>)}</ol>
      </>}
      <p className="quiet-note">黄色虚线为识别时轮廓，绿色实线为最近观测的平移估计，不是重新检测的精确框；只在连续匹配时显示。纹理不足、遮挡或极区畸变会停止跟踪。</p>
      <p className="quiet-note">当前不补偿相机运动，行走或转头时可能频繁失效。不预测未来位置，不判断距离或用户朝向；当前语音仍使用原识别结果，不会因这个面板更新、取消或提前。</p>
    </>}
  </section>;
}
