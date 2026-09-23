import { useEffect, useRef, useState, type RefObject } from 'react';
import { compareImuFrames, matchesImuVideo, parseImuRecording, sampleImu, type ImuRecording } from './imu';

type Loaded = { recording: ImuRecording; file: File; name: string };
type Frame = { pixels: Uint8Array; width: number; height: number; time: number; quaternion: number[] };
type Metrics = { time: number; sensor: NonNullable<ReturnType<typeof sampleImu>>; comparison: ReturnType<typeof compareImuFrames> | null };
const errorText = (error: unknown) => error instanceof Error ? error.message : '本地 IMU 对照失败，请重新选择数据。';
function changeText(before: number, after: number) {
  if (before === after) return '误差持平';
  const magnitude = before > 0 ? `${(Math.abs(after - before) / before * 100).toFixed(1)}%` : Math.abs(after - before).toFixed(4);
  return `误差${after < before ? '下降（改善）' : '上升（变差）'} ${magnitude}`;
}

export function ImuDiagnostics({ video, videoFile }: { video: RefObject<HTMLVideoElement | null>; videoFile: File | null }) {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadStatus, setLoadStatus] = useState('请选择与当前视频配套的 IMU 侧车 JSON。');
  const [captureStatus, setCaptureStatus] = useState('尚未启用本地采集。');
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const generation = useRef(0);
  const active = loaded?.file === videoFile ? loaded : null;

  useEffect(() => {
    generation.current++;
    setLoaded(null);
    setMetrics(null);
    setLoadStatus('视频已切换，请重新选择配套的 IMU 侧车 JSON。');
    return () => { generation.current++; };
  }, [videoFile]);

  async function load(file?: File) {
    if (!file) return;
    const token = ++generation.current;
    setLoaded(null);
    setMetrics(null);
    setLoadStatus('正在本地解析并核对视频指纹…');
    try {
      if (!videoFile) throw new Error('请先选择本地视频，拒绝载入未匹配的 IMU 数据。');
      if (file.size > 10 * 1024 * 1024) throw new Error('IMU JSON 超过 10 MB，已拒绝读取并清空旧记录。');
      const text = await file.text();
      if (token !== generation.current) return;
      const recording = parseImuRecording(text);
      if (!await matchesImuVideo(recording, videoFile)) throw new Error('视频指纹不匹配，已拒绝载入并清空旧记录。');
      if (token !== generation.current) return;
      setLoaded({ recording, file: videoFile, name: file.name });
      setLoadStatus('已匹配当前视频指纹（同一视频重命名不影响匹配）。');
    } catch (error) {
      if (token !== generation.current) return;
      setLoaded(null);
      setMetrics(null);
      setLoadStatus(`${errorText(error)} 未保留旧记录。`);
    }
  }

  useEffect(() => {
    setMetrics(null);
    if (!enabled || !active) {
      setCaptureStatus(enabled ? '等待与当前视频匹配的 IMU 数据。' : '尚未启用本地采集。');
      return;
    }
    const element = video.current;
    if (!element) { setCaptureStatus('等待视频元素就绪。'); return; }
    const { recording } = active;
    let previous: Frame | null = null;
    let context: CanvasRenderingContext2D | null = null;
    let frameId: number | null = null;
    let timer: number | null = null;
    let lastCapture = -Infinity;
    let disposed = false;
    const clear = (message: string) => { previous = null; setMetrics(null); setCaptureStatus(message); };
    const cancel = () => {
      if (frameId !== null) element.cancelVideoFrameCallback?.(frameId);
      if (timer !== null) window.clearTimeout(timer);
      frameId = timer = null;
    };
    const blocked = () => document.hidden ? '页面已隐藏，已清空帧对照。'
      : element.ended ? '播放结束，已清空帧对照。' : element.seeking ? '正在跳转，已清空帧对照。'
        : element.paused ? '视频已暂停，已清空帧对照。' : element.readyState < 2 ? '等待视频画面就绪。' : '';
    const schedule = () => {
      if (disposed) return;
      if (typeof element.requestVideoFrameCallback === 'function') {
        frameId = element.requestVideoFrameCallback((now, metadata) => tick(now, metadata.mediaTime));
      } else timer = window.setTimeout(() => tick(performance.now()), 150);
    };
    const tick = (now: number, mediaTime?: number) => {
      frameId = timer = null;
      if (disposed) return;
      const reason = blocked();
      if (reason) { clear(reason); return; }
      if (now - lastCapture >= 150) {
        lastCapture = now;
        try {
          if (!element.videoWidth || element.videoWidth !== element.videoHeight * 2) {
            clear('当前视频本身不是 2:1 全景画面，禁止 IMU 帧对照。');
            return;
          }
          if (recording.calibration.accepted && !context) {
            const canvas = document.createElement('canvas');
            canvas.width = 320; canvas.height = 160;
            context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) throw new Error('浏览器无法创建本地 Canvas，已停止帧对照。');
          }
          const time = mediaTime ?? element.currentTime;
          if (context) context.drawImage(element, 0, 0, 320, 160);
          const sensor = sampleImu(recording, time);
          if (!sensor) clear(`视频 ${time.toFixed(3)} 秒：IMU 时间越界或采样间断（gap），已清空对照。`);
          else if (!recording.calibration.accepted) {
            previous = null;
            setMetrics({ time, sensor, comparison: null });
            setCaptureStatus('标定未通过：禁止旋转补偿，仅显示传感器读数。');
          } else if (context) {
            const rgba = context.getImageData(0, 0, 320, 160).data;
            const pixels = new Uint8Array(320 * 160);
            for (let i = 0; i < pixels.length; i++) pixels[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
            const current: Frame = { pixels, width: 320, height: 160, time, quaternion: sensor.quaternion };
            const continuous = previous && time > previous.time && time - previous.time <= 0.6;
            const comparison = previous && continuous ? compareImuFrames(previous, current, previous.quaternion, current.quaternion) : null;
            setMetrics({ time, sensor, comparison });
            setCaptureStatus(comparison ? '本地连续帧光度误差对照中。' : previous ? '视频时间未递增或间隔超过 0.6 秒，已重新取前帧。' : '已取前帧，等待连续第二帧。');
            previous = current;
          }
        } catch (error) { clear(errorText(error)); return; }
      }
      schedule();
    };
    const restart = () => {
      cancel();
      lastCapture = -Infinity;
      const reason = blocked();
      clear(reason || '等待连续视频帧。');
      if (!reason) schedule();
    };
    const events = ['play', 'playing', 'pause', 'seeking', 'seeked', 'ended', 'emptied', 'waiting', 'loadeddata', 'resize'];
    events.forEach(event => element.addEventListener(event, restart));
    document.addEventListener('visibilitychange', restart);
    restart();
    return () => {
      disposed = true;
      cancel();
      previous = null;
      if (context) { context.canvas.width = 0; context = null; }
      events.forEach(event => element.removeEventListener(event, restart));
      document.removeEventListener('visibilitychange', restart);
    };
  }, [enabled, active, video, videoFile]);

  const calibration = active?.recording.calibration;
  const current = enabled && active ? metrics : null;
  return <section className="tracking-panel" aria-label="IMU旋转补偿验证">
    <h3>IMU旋转补偿验证 <span className="tag subtle">仅本地 · 不影响播报</span></h3>
    <label className="tracking-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用本地 IMU 对照（不上传）</label>
    <label className="file-picker">选择 IMU 侧车 JSON（最多 10 MB）
      <input type="file" aria-label="选择 IMU 数据" accept="application/json,.json" disabled={!videoFile} onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        void load(file);
      }} />
    </label>
    <p className="quiet-note">X4 Air IMU + 2:1 全景视频的本地逐帧旋转补偿对照。仅显式启用后采集；最多保留前后 2 帧 320×160 灰度图，Canvas 仅用于本地对照，不上传、不落盘。</p>
    <p className="tracking-summary" role="status">{loadStatus}</p>
    {active && <>
      <p className="tracking-count">数据文件：{active.name} · 相机型号：{active.recording.camera}</p>
      {calibration && <>
        <p className="quiet-note">离线保留帧对照（{calibration.pairs} 对）：误差 {calibration.baseline_error.toFixed(4)} → {calibration.compensated_error.toFixed(4)}；{changeText(calibration.baseline_error, calibration.compensated_error)}。</p>
        {!calibration.accepted && <p className="tracking-summary">标定未通过，禁止旋转补偿；仍可查看传感器读数。</p>}
      </>}
    </>}
    <p className="quiet-note" role="status">{captureStatus}</p>
    {current && <>
      <p className="tracking-count">视频 {current.time.toFixed(3)} 秒 · 相机角速度 {current.sensor.angularSpeed.toFixed(2)} °/s · 加速度模长 {current.sensor.accelerationNorm.toFixed(3)} g</p>
      <p className="quiet-note">未经补偿画面差异：{current.comparison?.baseline.toFixed(4) ?? '—'} · 旋转补偿后差异：{current.comparison?.compensated.toFixed(4) ?? '—'}{current.comparison && ` · ${changeText(current.comparison.baseline, current.comparison.compensated)}`}</p>
    </>}
    <p className="quiet-note">以上仅为光度误差，不足以说明运动预测准确率。加速度模长含重力，不是人的线性加速度或速度。手持相机转动不等于身体转向，不估计人的位置或速度。</p>
    <p className="quiet-note">此对照独立于模型、目标跟踪和语音，不自动联动识别或播报。暂停、跳转、结束、隐藏、取消启用及换视频均清空帧对照，换视频须重新匹配数据。</p>
  </section>;
}
