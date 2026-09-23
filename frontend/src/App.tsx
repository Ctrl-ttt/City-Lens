import { useEffect, useRef, useState } from 'react';
import { Accessibility, ALargeSmall, Camera, Contrast, FileVideo, Headphones, Info, Pause, Play, RotateCcw, ScanText, Square, Volume2, VolumeX } from 'lucide-react';
import type { Analysis, Channel, FoodDetail, FoodResult, Health, Mode, Projection, RealtimeState, Source, SpeechDetailLevel } from './types';
import { SessionGate, HttpError } from './session';
import { FramePacer, waitForVideoFrame } from './capture';
import { directionFromBox, estimateLocalProximity, FrameHistory, rewriteSpeechForMotion, snapshotVideo, trackTrajectory, type GrayFrame } from './motion';
import { SpeechQueue, browserVoiceDriver, chineseVoice, type Candidate } from './speech';
import { captureRealtimeFrame, RealtimeClient } from './realtime';
import { FOOD_DETAIL_STORAGE, foodDetailNames, loadFoodDetail, buildFoodSpeech } from './food';
import cityLensMark from './assets/citylens-mark.svg';
import { PanoramaObserver, type PanoramaAnchor } from './panoramaObserver';
import { PanoramaDiagnostics, PanoramaOverlay, useTrackingFreshness } from './PanoramaDiagnostics';
import { projectFaceBox, type TrackingSnapshot, type PanoramaTrack } from './panoramaTracking';
import { ImuDiagnostics } from './ImuDiagnostics';
import './brand.css';

const sourceNames = { camera: '实时摄像头', video: '路线视频回放' };
const directionNames = { left: '左侧', front: '前方', right: '右侧', back: '后方', above: '上方', unknown: '画面中' };
type PredictionAudit = {
  state: 'unused' | 'kept' | 'blocked' | 'observed';
  title: string;
  detail: string;
  ageMs: number;
  matched: number;
  attempted: number;
};

export default function App() {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const objectUrl = useRef<string | null>(null);
  const gate = useRef(new SessionGate());
  const readGate = useRef(new SessionGate());
  const active = useRef(false);
  const sourceRef = useRef<Source>('camera');
  const channelRef = useRef<Channel>('http');
  const realtime = useRef<RealtimeClient | null>(null);
  const healthRef = useRef<Health | null>(null);
  const mounted = useRef(false);
  const observer = useRef<PanoramaObserver | null>(null);
  const trackingEnabledRef = useRef(false);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const [tracking, setTracking] = useState<TrackingSnapshot | null>(null);
  const [trackingError, setTrackingError] = useState('');
  const [overlayTracks, setOverlayTracks] = useState<PanoramaTrack[]>([]);
  const trackingFreshness = useTrackingFreshness(tracking);
  const [channel, setChannel] = useState<Channel>('http');
  const [connectionState, setConnectionState] = useState<RealtimeState>('waiting');
  const internalSeek = useRef(false);
  const queue = useRef<SpeechQueue | null>(null);
  const last = useRef<Candidate | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState('');
  const [source, setSource] = useState<Source>('camera');
  const [projection, setProjection] = useState<Projection>('rectilinear');
  const [heading, setHeading] = useState(0);
  const [reading, setReading] = useState(false);
  const readingRef = useRef(false);
  const internalRead = useRef(false);
  const cooldownUntil = useRef(0);
  const httpPacer = useRef(new FramePacer());
  // HTTP remains single-flight, but a slow model must not make the next timer
  // tick disappear.  Keep only the fact that a newer frame is wanted; the
  // frame is captured after the current request completes, so it is genuinely
  // the newest decoded video frame rather than an old JPEG waiting in a queue.
  const pendingHttpMode = useRef<Mode | null>(null);
  const motionFrames = useRef(new Map<string, GrayFrame>());
  const frameHistory = useRef(new FrameHistory());
  const scratch = useRef<HTMLCanvasElement | null>(null);
  const foodScratch = useRef<HTMLCanvasElement | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [ready, setReady] = useState(false);
  const [consent, setConsent] = useState(false);
  const [muted, setMuted] = useState(false);
  const [voiceName, setVoiceName] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [notice, setNotice] = useState('选择输入，开始了解周围环境');
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [activeCameraLabel, setActiveCameraLabel] = useState('');
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<Analysis | null>(null);
  const [foodResult, setFoodResult] = useState<FoodResult | null>(null);
  const [foodBusy, setFoodBusy] = useState(false);
  const [foodDetail, setFoodDetail] = useState<FoodDetail>(loadFoodDetail);
  const [history, setHistory] = useState<Analysis[]>([]);
  const [roundtrip, setRoundtrip] = useState(0);
  const [predictionAudit, setPredictionAudit] = useState<PredictionAudit | null>(null);
  const [singleOnly, setSingleOnly] = useState(false);
  const [largeText, setLargeText] = useState(false);
  const [highContrast, setHighContrast] = useState(false);
  const [speechThreshold, setSpeechThreshold] = useState(70);
  const [speechDetail, setSpeechDetail] = useState<SpeechDetailLevel>('medium');

  if (!queue.current) queue.current = new SpeechQueue(browserVoiceDriver(() => setVoiceError('语音播放失败，请检查系统中文语音和输出设备。')), () => [gate.current.session, readGate.current.session]);

  async function checkHealth() {
    try {
      const response = await fetch('/api/health', { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error();
      const value: Health = await response.json();
      if (!['live', 'sample', 'realtime'].includes(value.provider)) throw new Error();
      if (!mounted.current) return;
      if (!healthRef.current || healthRef.current.provider !== value.provider) {
        invalidate();
        const next = value.provider === 'realtime' ? 'realtime' : 'http';
        channelRef.current = next; setChannel(next); setConnectionState('waiting');
      }
      healthRef.current = value; setHealth(value); setHealthError('');
      if (value.speech_score_threshold !== undefined) setSpeechThreshold(value.speech_score_threshold);
      if (value.speech_detail_level) setSpeechDetail(value.speech_detail_level);
    } catch { if (mounted.current) { invalidate(); setHealth(null); setHealthError('后端未连接，请运行启动脚本后重新检查。'); } }
  }

  function closeRealtime() {
    const client = realtime.current;
    realtime.current = null;
    client?.close();
    if (client) setConnectionState('disconnected');
  }
  function clearTracking() {
    observer.current?.dispose(); observer.current = null;
    setTracking(null); setTrackingError(''); setOverlayTracks([]);
  }
  function toggleTracking(enabled: boolean) {
    trackingEnabledRef.current = enabled; setTrackingEnabled(enabled); clearTracking();
  }
  function clearResults() {
    queue.current?.clear(); last.current = null;
    motionFrames.current.clear();
    frameHistory.current.clear();
    setResult(null); setFoodResult(null); setHistory([]); setRoundtrip(0); setPredictionAudit(null);
    clearTracking();
  }
  function invalidate(message?: string) {
    httpPacer.current.reset();
    pendingHttpMode.current = null;
    active.current = false; setRunning(false); setBusy(false); setConnecting(false);
    closeRealtime(); gate.current.reset(); clearResults();
    if (message) setNotice(message);
  }
  function changeChannel(next: Channel) {
    if (projection === 'equirectangular' && next === 'realtime') return;
    if (next === channelRef.current || health?.provider === 'sample') return;
    invalidate('识别通道已切换，请重新开始');
    if (sourceRef.current === 'video') video.current?.pause();
    channelRef.current = next; setChannel(next); setError('');
    setConnectionState('waiting');
  }
  function releaseCamera() {
    stream.current?.getTracks().forEach(t => { t.onended = null; t.stop(); });
    stream.current = null;
    setActiveCameraLabel('');
    if (video.current) video.current.srcObject = null;
  }
  function changeSource(next: Source) {
    invalidate('输入已切换，请重新开始'); releaseCamera();
    if (video.current) { video.current.pause(); video.current.removeAttribute('src'); video.current.load(); }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null; setFileName(''); setVideoFile(null); setReady(false); setError('');
    sourceRef.current = next; setSource(next);
    setProjection('rectilinear'); setHeading(0);
  }
  function changeProjection(next: Projection) {
    invalidate('画面格式已切换，请确认正前方后重新开始');
    if (sourceRef.current === 'video') video.current?.pause();
    setProjection(next); setHeading(0);
    if (next === 'equirectangular') { channelRef.current = 'http'; setChannel('http'); }
  }
  function pause() {
    invalidate('已暂停。按开始恢复识别');
    if (sourceRef.current === 'video') video.current?.pause();
  }
  function failure(message: string) {
    queue.current?.clear(); last.current = null; setResult(null); setRoundtrip(0); setPredictionAudit(null);
    setNotice('本次识别不可用，请重新观察当前画面');
    if (gate.current.failed()) { invalidate('已暂停自动识别'); setError(`${message} 连续三次失败，请检查后重新开始。`); }
    else setError(message);
  }

  // The timer and reconnect callbacks always see the current channel and state.
  const analyzeRef = useRef(analyze);
  analyzeRef.current = analyze;
  useEffect(() => {
    // Poll readiness between send slots so encoding time cannot skip a whole second.
    // A read turn parks this timer so an HTTP read cannot race the realtime lock.
    // The rate-limit cooldown pauses walk rounds until the provider window clears.
    const timer = setInterval(() => {
      if (active.current && !readingRef.current && Date.now() >= cooldownUntil.current
          && (channelRef.current === 'realtime' || httpPacer.current.ready(Date.now()))) void analyzeRef.current('walk');
    }, 100);
    return () => clearInterval(timer);
  }, [channel]);

  useEffect(() => {
    if ((!running && !busy) || !ready || projection !== 'rectilinear') return;
    const sample = () => {
      const element = video.current;
      if (!element || element.readyState < 2 || document.hidden) return;
      frameHistory.current.add(Date.now(), snapshotVideo(element, sourceRef.current === 'camera'));
    };
    sample();
    const timer = setInterval(sample, 400);
    return () => clearInterval(timer);
  }, [running, busy, ready, projection, source]);

  useEffect(() => {
    mounted.current = true;
    void checkHealth();
    const refreshVoices = () => { setVoiceName(chineseVoice()?.name ?? ''); };
    refreshVoices();
    window.speechSynthesis?.addEventListener('voiceschanged', refreshVoices);
    const onHidden = () => { if (document.hidden) invalidate('页面进入后台，识别已暂停'); };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      mounted.current = false; active.current = false;
      const client = realtime.current; realtime.current = null; client?.close();
      gate.current.reset(); queue.current?.clear(); releaseCamera();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      document.removeEventListener('visibilitychange', onHidden);
      window.speechSynthesis?.removeEventListener('voiceschanged', refreshVoices);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const available = await navigator.mediaDevices?.enumerateDevices();
        if (!disposed && available) setDevices(available.filter(d => d.kind === 'videoinput'));
      } catch { /* Permission is requested only by the user's preview/start action. */ }
    };
    void refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => { disposed = true; navigator.mediaDevices?.removeEventListener('devicechange', refresh); };
  }, []);

  async function prepareCamera(): Promise<boolean> {
    if (stream.current && video.current?.readyState && video.current.readyState >= 2) return true;
    const session = gate.current.session;
    setConnecting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera unavailable');
      const media = await navigator.mediaDevices.getUserMedia({ video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (gate.current.session !== session || sourceRef.current !== 'camera') { media.getTracks().forEach(t => t.stop()); return false; }
      stream.current = media;
      media.getVideoTracks()[0].onended = () => { invalidate('摄像头已断开'); releaseCamera(); setReady(false); setError('请重新连接摄像头，然后开始识别。'); };
      video.current!.srcObject = media;
      await video.current!.play();
      if (gate.current.session !== session) { if (stream.current === media) releaseCamera(); return false; }
      const available = await navigator.mediaDevices.enumerateDevices();
      if (gate.current.session !== session) return false;
      setDevices(available.filter(d => d.kind === 'videoinput'));
      setActiveCameraLabel(media.getVideoTracks()[0].label);
      setReady(true); return true;
    } catch {
      if (gate.current.session === session) { releaseCamera(); setReady(false); setError('摄像头不可用：请允许浏览器访问，并检查 USB 连接及是否被其它软件占用。'); }
      return false;
    } finally { if (gate.current.session === session) setConnecting(false); }
  }

  async function previewCamera() {
    if (connecting || document.hidden) return;
    invalidate('仅本地预览，不上传画面。确认摄像头后可开始识别。');
    setError('');
    await prepareCamera();
  }

  function connectRealtime() {
    const client = new RealtimeClient({
      onState: state => { if (realtime.current === client) setConnectionState(state); },
      onReady: () => {
        if (realtime.current !== client) return;
        setError('');
        // A freshly spoken sign must stay on screen; the connection note never replaces a published result.
        if (!last.current) setNotice('已连接，正在观察新画面');
        void analyzeRef.current('walk');
      },
      onResult: (data, capturedAt) => {
        if (realtime.current !== client || data.session_id !== gate.current.session) return;
        setBusy(false);
        publishResult(data, capturedAt, false);
        // A keypress owns one analysis turn, not an idle, billable connection.
        if (realtime.current === client && !active.current) closeRealtime();
      },
      onDisconnect: (reason, retrying) => {
        if (realtime.current !== client) return;
        // Fence old frames and speech without cancelling this client's bounded recovery.
        gate.current.reset(); clearResults(); setBusy(false);
        setError(`${reason.message} 可切换 HTTP 抽帧后重新开始。`);
        setNotice(retrying ? '实时连接恢复中，恢复后只分析新画面' : '实时连接已断开，请重新开始或切换 HTTP 抽帧');
        if (!retrying) { active.current = false; setRunning(false); }
      },
    });
    realtime.current = client;
    client.start();
  }

  async function start(readMode = false, once = false) {
    if (!consent || !(readMode ? httpConfigured : channelConfigured) || connecting || document.hidden) return;
    if (!readMode) { invalidate(); setError(''); cooldownUntil.current = 0; }
    // A read turn is an independent signal: it never tears down the running walk stream.
    const session = gate.current.session;
    const wasRunning = readMode && active.current;
    if (readMode) {
      if (readingRef.current) return;
      readingRef.current = true; setReading(true); setNotice('正在读取标牌'); internalRead.current = true;
      // Park the realtime stream so the HTTP read turn does not race the backend lock.
      closeRealtime();
    }
    const requestedMode: Mode = readMode ? 'read' : 'walk';
    try {
      if (sourceRef.current === 'camera' && !(await prepareCamera())) return;
      if (session !== gate.current.session) return;
      if (!video.current || video.current.readyState < 2) { setError('请先连接摄像头或选择可播放的 MP4 视频。'); return; }
      if (sourceRef.current === 'video') {
        if (video.current.ended) {
          const element = video.current;
          internalSeek.current = true;
          try {
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => { cleanup(); reject(new Error('seek timeout')); }, 3000);
              const cleanup = () => { clearTimeout(timeout); element.removeEventListener('seeked', done); };
              const done = () => { cleanup(); resolve(); };
              element.addEventListener('seeked', done, { once: true });
              element.currentTime = 0;
            });
          } catch { if (session === gate.current.session) setError('视频无法回到开头，请重新选择文件。'); return; }
          finally { internalSeek.current = false; }
        }
        if (session !== gate.current.session) return;
        if (readMode || once || singleOnly) {
          const element = video.current;
          // HAVE_CURRENT_DATA may precede the first usable decoded frame on Edge.
          // Advance only an unstarted clip; subsequent keypresses keep its paused position.
          if (element.currentTime === 0 && 'requestVideoFrameCallback' in element) {
            try {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => { element.cancelVideoFrameCallback(id); reject(new Error('frame timeout')); }, 3000);
                const id = element.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
                void element.play().catch(reason => { clearTimeout(timer); element.cancelVideoFrameCallback(id); reject(reason); });
              });
            } catch { if (session === gate.current.session) setError('视频首帧尚未就绪，请播放后暂停再识别。'); return; }
            finally { if (session === gate.current.session) element.pause(); }
          } else element.pause();
        }
        else { try { await video.current.play(); } catch { if (session === gate.current.session) setError('视频无法播放，请检查视频格式。'); return; } }
      }
      if (session !== gate.current.session) return;
      if (!readMode) {
        active.current = !once && !singleOnly;
        setRunning(active.current); setNotice('正在观察当前画面');
      }
      if (!readMode && channelRef.current === 'realtime') {
        connectRealtime();
      } else await analyze(requestedMode);
    } finally {
      if (readMode) {
        readingRef.current = false; setReading(false);
        if (session !== gate.current.session) { internalRead.current = false; return; }
        // Resume the parked walk stream where it left off.
        if (wasRunning && active.current) {
          if (sourceRef.current === 'video' && video.current) {
            try { await video.current.play(); } catch { /* walk already reported its own errors */ }
          }
          if (channelRef.current === 'realtime' && !document.hidden) connectRealtime();
        }
        internalRead.current = false;
      }
    }
  }

  function motionKey(session: string, frame: number) { return `${session}:${frame}`; }
  function rememberMotionFrame(session: string, frame: number, image: GrayFrame | null) {
    if (!image) return;
    const frames = motionFrames.current;
    frames.set(motionKey(session, frame), image);
    while (frames.size > 20) frames.delete(frames.keys().next().value!);
  }
  function compensateStaleResult(data: Analysis, capturedAt: number, manual: boolean): { data: Analysis; audit: PredictionAudit } {
    const key = motionKey(data.session_id, data.frame_id);
    const reference = motionFrames.current.get(key);
    const ageMs = Math.max(0, Date.now() - capturedAt);
    const base = (state: PredictionAudit['state'], title: string, detail: string, matched = 0, attempted = 0) =>
      ({ state, title, detail, ageMs, matched, attempted });
    // Results from dropped realtime frames cannot accumulate local image history.
    for (const entry of motionFrames.current.keys()) if (entry.startsWith(`${data.session_id}:`)) {
      const frame = Number(entry.slice(data.session_id.length + 1));
      if (frame <= data.frame_id) motionFrames.current.delete(entry);
    }
    if (manual) return { data, audit: base('unused', '预测未参与播报', '手动看牌使用原始画面结果。') };
    if (projection !== 'rectilinear') return { data, audit: base('unused', '预测未参与播报', '全景模式使用服务端方向判断。') };
    if (ageMs < 1000) return { data, audit: base('unused', '无需延迟补偿', '结果在一秒内返回，直接使用原始播报。') };
    const spokenPrefixes = new Set((data.speech?.key ?? '').split('|').map(key => key.replace(/:(?:approaching|near)$/, '')));
    if (!reference) return { data, audit: base('unused', '预测不可用', '没有找到发送时的本地参考帧，结果未做位置校正。') };
    const current = video.current && snapshotVideo(video.current, sourceRef.current === 'camera');
    if (!current) return { data, audit: base('unused', '预测不可用', '当前视频帧无法读取，结果未做位置校正。') };
    const now = Date.now();
    const frames = frameHistory.current.after(capturedAt, now);
    if (!frames.length || now - frames.at(-1)!.at > 100) frames.push({ at: now, image: current });
    else frames[frames.length - 1] = { at: now, image: current };
    let allSpokenObstaclesTracked = true, allSpokenObstaclesRelevant = true;
    let matched = 0, attempted = 0, directionChanges = 0, longestTrack = 0;
    const events = data.events.map(event => {
      const spoken = spokenPrefixes.has(`${event.label}:${event.direction}`);
      if (!event.box) {
        if (spoken && event.category === 'obstacle') allSpokenObstaclesTracked = false;
        return event;
      }
      attempted++;
      const trajectory = trackTrajectory(reference, event.box, capturedAt, frames, 2.5);
      if (!trajectory) {
        if (spoken && event.category === 'obstacle') allSpokenObstaclesTracked = false;
        return event;
      }
      matched++;
      longestTrack = Math.max(longestTrack, trajectory.samples);
      const direction = event.direction === 'above' ? 'above' : directionFromBox(trajectory.predictedBox, event.direction);
      if (direction !== event.direction) directionChanges++;
      const proximity = estimateLocalProximity(event.label, trajectory.box, current.width / current.height, healthRef.current?.camera_hfov_deg ?? 75);
      if (spoken && event.category === 'obstacle' && proximity === 'far') allSpokenObstaclesRelevant = false;
      const locallyApproaching = trajectory.approaching && proximity === 'near' && ['person','car','motorcycle'].includes(event.label);
      return { ...event, original_direction: event.direction, direction, original_box: event.box, box: trajectory.box,
        predicted_box: trajectory.predictedBox, proximity, approaching: event.approaching || locallyApproaching, motion_compensated: true,
        direction_predicted: direction !== event.direction, motion_samples: trajectory.samples,
        forecast_seconds: trajectory.forecastSeconds, approach_rate: trajectory.approachRate, speed_level: trajectory.speedLevel };
    });
    // A late obstacle warning is withheld if its labelled region has disappeared
    // or cannot be uniquely located in the newest frame.  Text-only reads remain
    // governed by their separate manual freshness budget.
    const lateObstacleSpeech = !!data.speech && data.events.some(event => event.category === 'obstacle'
      && spokenPrefixes.has(`${event.label}:${event.direction}`));
    const blocked = lateObstacleSpeech && (!allSpokenObstaclesTracked || !allSpokenObstaclesRelevant);
    let speech = blocked ? null : data.speech;
    if (speech) speech = rewriteSpeechForMotion(speech, events, directionNames);
    const adjusted = { ...data, events, speech };
    const title = blocked ? '预测已取消旧播报' : matched ? (data.speech ? '预测后保留播报' : '预测已校正目标') : '预测未找到可靠位移';
    const detail = blocked ? (!allSpokenObstaclesTracked ? '播报目标未能在连续画面中可靠匹配，因此没有播放旧提示。' : '本地粗略距离显示目标已经处于较远区域，因此取消旧提示。')
      : matched ? `已用最多 ${longestTrack} 个本地帧将 ${matched} 个目标更新到当前画面${directionChanges ? `，并更新了 ${directionChanges} 个方向。` : '。'}${data.speech ? ' 播报内容保持有效。' : ''}`
      : '目标纹理不足、画面变化过大或匹配不唯一，未修改位置。';
    return { data: adjusted, audit: base(blocked ? 'blocked' : matched && data.speech ? 'kept' : 'observed', title, detail, matched, attempted) };
  }

  function publishResult(raw: Analysis, capturedAt: number, manual: boolean) {
    const compensated = compensateStaleResult(raw, capturedAt, manual);
    const data = compensated.data;
    if (data.session_id !== gate.current.session) return;
    // Do not reject a model response based on elapsed time. Slow inference is
    // expected; show its result and let the motion-compensation audit explain
    // whether a local track was available.
    const maxAge = Number.POSITIVE_INFINITY;
    gate.current.succeeded(); setError(''); setResult(data); setRoundtrip(Date.now() - capturedAt); setPredictionAudit(compensated.audit);
    setHistory(items => [data, ...items].slice(0, 5));
    setNotice(data.speech?.text ?? (data.status === 'uncertain' ? '画面不清晰，请调整拍摄角度' : '本帧没有可确认的提示；不代表通行安全'));
    if (data.speech) {
      const candidate = { ...data.speech, session: data.session_id, capturedAt, maxAge, manual };
      last.current = candidate; queue.current?.offer(candidate);
    } else last.current = null;
  }

  async function analyze(requestedMode: Mode) {
    const element = video.current;
    const useRealtime = requestedMode === 'walk' && channelRef.current === 'realtime';
    const client = useRealtime ? realtime.current : null;
    if (!element || element.readyState < 2 || element.videoWidth === 0 || document.hidden) {
      if (client && !active.current) { closeRealtime(); setNotice('当前画面不可用，请重新开始'); }
      return;
    }
    if (useRealtime) {
      // No ticket, pending promise or image capture while unready, paced or backpressured.
      if (!client?.canSend) return;
      const capturedAt = Date.now();
      try {
        const frame = ++gate.current.frame;
        const reference = snapshotVideo(element, sourceRef.current === 'camera');
        if (client.send({ type: 'frame', session_id: gate.current.session, frame_id: frame, mode: 'walk', source: sourceRef.current, image: captureRealtimeFrame(element, sourceRef.current === 'camera'), speech_threshold: speechThreshold, speech_detail_level: speechDetail }, capturedAt)) {
          rememberMotionFrame(gate.current.session, frame, reference);
          frameHistory.current.add(capturedAt, reference);
          setBusy(true);
        }
      } catch (reason) {
        if (realtime.current !== client) return;
        closeRealtime(); active.current = false; setRunning(false); setBusy(false);
        failure(reason instanceof Error ? reason.message : '识别失败，请重试。');
      }
      return;
    }
    if (requestedMode === 'walk' && Date.now() < cooldownUntil.current) return;
    // HTTP (including manual reading) remains strictly single-flight.  During a
    // slow request retain one latest-frame request instead of silently dropping
    // every timer tick.  The actual capture happens in the finally continuation
    // below, immediately after the in-flight request is released.
    if (gate.current.pending && requestedMode === 'walk' && active.current && !readingRef.current) {
      pendingHttpMode.current = requestedMode;
      return;
    }
    const ticket = gate.current.acquire(Date.now());
    if (!ticket) return;
    httpPacer.current.started(Date.now());
    setBusy(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const canvas = scratch.current ??= document.createElement('canvas');
      if (projection === 'equirectangular' && Math.abs(element.videoWidth / element.videoHeight - 2) > 0.04) throw new Error('请选择已拼接的 2:1 全景 MP4；双鱼眼原片不能直接识别。');
      await waitForVideoFrame(element, ticket.controller.signal);
      if (!gate.current.current(ticket)) return;
      const scale = Math.min(1, (projection === 'equirectangular' ? 1920 : requestedMode === 'read' ? 1280 : 960) / Math.max(element.videoWidth, element.videoHeight));
      const width = Math.round(element.videoWidth * scale), height = Math.round(element.videoHeight * scale);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext('2d')!;
      const flip = sourceRef.current === 'camera' && projection === 'rectilinear';
      context.setTransform(flip ? -1 : 1, 0, 0, 1, flip ? canvas.width : 0, 0);
      ticket.capturedAt = Date.now();
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      const reference = snapshotVideo(element, flip);
      rememberMotionFrame(ticket.session, ticket.frame, reference);
      frameHistory.current.add(ticket.capturedAt, reference);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.75));
      if (!gate.current.current(ticket)) return;
      if (!blob) throw new Error('无法读取当前画面，请重新选择输入。');
      const form = new FormData();
      form.append('image', blob, 'frame.jpg'); form.append('mode', requestedMode); form.append('source', sourceRef.current);
      form.append('session_id', ticket.session); form.append('frame_id', String(ticket.frame));
      form.append('projection', projection); form.append('heading_deg', String(heading));
      form.append('speech_threshold', String(speechThreshold)); form.append('speech_detail_level', speechDetail);
      timer = setTimeout(() => ticket.controller.abort(), 9000);
      const response = await fetch('/api/analyze', { method: 'POST', body: form, signal: ticket.controller.signal });
      const data: Analysis = await response.json();
      if (!gate.current.current(ticket)) return;
      if (!response.ok || data.status === 'error')
        throw new HttpError(data.error_code ?? String(response.status), data.message || '识别服务不可用，请稍后重试。');
      if (data.session_id !== ticket.session || data.frame_id !== ticket.frame || !Array.isArray(data.events)) throw new Error('响应不匹配，请重新观察。');
      publishResult(data, ticket.capturedAt, requestedMode === 'read');
    } catch (reason) {
      if (!gate.current.current(ticket)) return;
      const error = reason instanceof HttpError ? reason
        : reason instanceof DOMException && reason.name === 'AbortError' ? new HttpError('model_timeout', '识别超时，请检查网络。')
        : reason instanceof TypeError ? new HttpError('network_error', '无法连接识别服务，请检查网络。')
        : reason instanceof Error ? reason : new Error('识别失败，请重试。');
      if (error instanceof HttpError && error.transient) {
        httpPacer.current.defer(Date.now(), error.code === 'busy' ? 1000 : 1000);
        // Congestion and rate limits self-heal; keep the last result and keep trying.
        if (error.code === 'rate_limited') { cooldownUntil.current = Date.now() + 15000; setError('模型请求过于频繁，已自动放慢节奏，稍后恢复。'); }
        else if (error.code !== 'busy') setError(error.message);
        return;
      }
      failure(error.message);
    } finally {
      if (timer) clearTimeout(timer);
      gate.current.finish(ticket);
      if (gate.current.current(ticket)) setBusy(false);
      const nextMode = pendingHttpMode.current;
      pendingHttpMode.current = null;
      if (nextMode && gate.current.current(ticket) && active.current && !readingRef.current
          && channelRef.current === 'http' && !document.hidden && Date.now() >= cooldownUntil.current
          && httpPacer.current.ready(Date.now())) {
        void analyze(nextMode);
      }
    }
  }

  async function analyzeSkylight() {
    const element = video.current;
    if (foodBusy || !element || element.readyState < 2 || element.videoWidth === 0 || document.hidden) return;
    if (projection === 'equirectangular' && Math.abs(element.videoWidth / element.videoHeight - 2) > 0.04) {
      setError('请选择已拼接的 2:1 全景输入；X4 Air 原始双鱼眼文件需先导出全景 MP4。');
      return;
    }
    setFoodBusy(true); setError('');
    try {
      const canvas = foodScratch.current ??= document.createElement('canvas');
      const scale = Math.min(1, 1920 / Math.max(element.videoWidth, element.videoHeight));
      canvas.width = Math.round(element.videoWidth * scale);
      canvas.height = Math.round(element.videoHeight * scale);
      const context = canvas.getContext('2d')!;
      const flip = sourceRef.current === 'camera' && projection === 'rectilinear';
      context.setTransform(flip ? -1 : 1, 0, 0, 1, flip ? canvas.width : 0, 0);
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
      if (!blob) throw new Error('无法读取当前画面，请重新选择输入。');
      const form = new FormData();
      form.append('image', blob, 'skylight.jpg');
      form.append('projection', projection); form.append('heading_deg', String(heading));
      form.append('source', sourceRef.current);
      const response = await fetch('/api/plugins/skylight/analyze', { method: 'POST', body: form });
      const data = await response.json();
      if (!response.ok || data.error_code) throw new Error(data.message || '食材识别服务不可用，请稍后重试。');
      setFoodResult(data as FoodResult);
      const items = (data as FoodResult).items ?? [];
      setNotice(items.length ? `Skylight 识别到 ${items.length} 种食材` : '当前画面没有可确认的食材');
      const speech = buildFoodSpeech(items, foodDetail);
      queue.current?.offer({ key: 'skylight-food', priority: 'normal', text: speech, session: gate.current.session, capturedAt: Date.now(), maxAge: 20000, manual: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '食材识别失败，请重试。');
    } finally { setFoodBusy(false); }
  }

  function loadVideo(file?: File) {
    if (!file) return;
    invalidate('视频已选择，请开始识别'); releaseCamera(); setError(''); setReady(false);
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(file); setFileName(file.name); setVideoFile(file);
    video.current!.src = objectUrl.current; video.current!.load();
  }
  function replay() {
    if (!last.current) return;
    queue.current?.offer({ ...last.current, text: `上一条提示：${last.current.text}`, capturedAt: Date.now(), maxAge: 8000, manual: true });
  }
  function toggleMute() { const next = !muted; setMuted(next); queue.current?.mute(next); }
  function changeFoodDetail(next: FoodDetail) {
    setFoodDetail(next);
    try { localStorage.setItem(FOOD_DETAIL_STORAGE, next); } catch { /* private mode: keep the choice for this session only */ }
  }
  function voiceTest() {
    if (!voiceName) { setVoiceError('未发现中文语音。请在 Windows 语言设置安装中文语音后重启浏览器。'); return; }
    setVoiceError('');
    queue.current?.offer({ key: 'voice-test', priority: 'normal', text: 'CityLens 中文语音测试。请确认可以听到这句话。', session: gate.current.session, capturedAt: Date.now(), maxAge: 8000, manual: true });
  }
  const httpConfigured = !!health && health.http_configured;
  const realtimeConfigured = !!health && health.provider !== 'sample' && health.realtime_configured;
  const channelConfigured = channel === 'realtime' ? realtimeConfigured : httpConfigured;
  const skylightConfigured = !!health?.plugins?.skylight?.enabled && !!health?.plugins?.skylight?.configured;
  const permitted = consent && channelConfigured && !connecting;
  const connectionNames: Record<RealtimeState, string> = { waiting: '待连接', connecting: '连接中', connected: '已连接', recovering: '恢复中', disconnected: '已断开' };
  const currentModel = health?.provider === 'sample' ? health.model : reading || channel === 'http' ? health?.http_model : health?.realtime_model;

  return <div className={`shell ${largeText ? 'large-text' : ''} ${highContrast ? 'high-contrast' : ''}`}>
    <a className="skip" href="#controls">跳转到操作区</a>
    <header className="header">
      <a className="brand" href="#"><span className="lens-mark" aria-hidden="true"><img src={cityLensMark} alt=""/></span><span><strong>CityLens</strong><small>城市环境理解助手</small></span></a>
      <div className="header-tools" aria-label="显示设置">
        <span className={`system-state ${channelConfigured ? 'ready' : ''}`}><span aria-hidden="true"/>{channelConfigured ? '服务已就绪' : '服务未就绪'}</span>
        <button className="display-toggle" aria-pressed={largeText} onClick={() => setLargeText(value => !value)}><ALargeSmall aria-hidden="true"/>大字</button>
        <button className="display-toggle" aria-pressed={highContrast} onClick={() => setHighContrast(value => !value)}><Contrast aria-hidden="true"/>高对比</button>
      </div>
    </header>
    <main>
      <section className={`now-panel ${error ? 'has-error' : ''}`} aria-labelledby="current-notice">
        <div className="now-heading">
          <span className="mode-label"><Accessibility aria-hidden="true"/>{reading ? '看牌模式' : '环境提示'}</span>
          <span className="activity-label">{connecting ? '正在连接输入' : reading ? '正在读取标牌' : busy ? '正在识别' : running ? '自动观察中' : '等待操作'}</span>
        </div>
        <p className="now-kicker" id="current-notice">当前提示</p>
        <h1 className="live-caption" role="status" aria-live={muted || !voiceName ? 'polite' : 'off'}>{notice}</h1>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="now-actions" aria-label="播报操作">
          <button disabled={!last.current || muted || !voiceName} onClick={replay}><RotateCcw aria-hidden="true"/>重播上一条</button>
          <button aria-pressed={muted} onClick={toggleMute}>{muted ? <Volume2 aria-hidden="true"/> : <VolumeX aria-hidden="true"/>}{muted ? '取消静音' : '静音'}</button>
        </div>
      </section>
      {health?.provider === 'sample' && <div className="banner sample" role="status"><strong>样例联调模式 · 不是实际识别</strong><span>结果来自固定样例，不分析输入画面；不会发送至云端。场景：{health.sample_scene}</span></div>}
      {(healthError || (health && !channelConfigured)) && <div className="banner warning"><span>{healthError || '当前通道尚未配置，请切换已配置的通道或检查后重新开始。'}</span><button onClick={() => void checkHealth()}>重新检查</button></div>}
      <section className="control-card" id="controls" aria-labelledby="control-title">
        <div className="control-top"><div><p className="section-index">操作</p><h2 id="control-title">开始了解周围环境</h2></div><label className="switch-label"><input type="checkbox" checked={singleOnly} onChange={e => { invalidate('识别方式已切换'); setSingleOnly(e.target.checked); }}/><span>只用按键识别</span></label></div>
        <fieldset className="source-field"><legend>输入来源</legend><div className="source-tabs"><button aria-pressed={source==='camera'} onClick={() => changeSource('camera')}><Camera aria-hidden="true"/>实时摄像头</button><button aria-pressed={source==='video'} onClick={() => changeSource('video')}><FileVideo aria-hidden="true"/>路线视频回放</button></div></fieldset>
        {health && health.provider !== 'sample' && <fieldset className="channel-field"><legend>识别通道</legend><div className="source-tabs"><button aria-pressed={channel==='realtime'} disabled={!realtimeConfigured || projection === 'equirectangular'} onClick={() => changeChannel('realtime')}>实时连接</button><button aria-pressed={channel==='http'} disabled={!httpConfigured} onClick={() => changeChannel('http')}>HTTP 抽帧</button></div><p className="quiet-note">{channel === 'realtime' ? '浏览器以 1 fps 连续送帧；发送不等待分析。云端仍串行处理，忙时后端只保留最新待分析帧，结果可跳帧；不是云端双工或安全导航。' : 'HTTP 每秒尝试抽帧一次，分析忙时不排队。'} 未使用麦克风；手动看牌始终使用 HTTP。</p>{channel === 'realtime' && <p className="connection-state" role="status" aria-label="实时连接状态">实时连接：{connectionNames[connectionState]}</p>}</fieldset>}
        <fieldset className="source-field"><legend>画面格式</legend><label>输入格式 <select aria-label="画面格式" value={projection} onChange={e => changeProjection(e.target.value as Projection)}><option value="rectilinear">普通固定视角</option><option value="equirectangular">360° 全景（已拼接 2:1）</option></select></label>{projection === 'equirectangular' && <><p className="quiet-note">请使用 Insta360 Studio 导出的全景 MP4。HTTP 通道一次分析前、左、右、后、上、下六个方向；请保持相机朝向固定。原始 INSV 暂不直接播放。</p><label>正前方在全景中的角度：{heading}° <input aria-label="正前方角度" type="range" min="-180" max="180" step="15" value={heading} onChange={e => { invalidate('正前方已调整，请重新开始'); video.current?.pause(); setHeading(Number(e.target.value)); }}/></label><p className="quiet-note">0° 对应画面横向中央，+90° 对应画面右侧四分之三处；以路线前进方向校准。方向不随用户转头自动更新。</p></>}</fieldset>
        <fieldset className="source-field"><legend>播报策略</legend><label>详细度：<select aria-label="播报详细度" value={speechDetail} onChange={e => setSpeechDetail(e.target.value as SpeechDetailLevel)}><option value="low">低（仅方向，最多3项）</option><option value="medium">中（方向+距离，最多2项）</option><option value="high">高（方向+距离+速度，最多1项）</option></select></label><label>播报阈值：{speechThreshold} 分 <input aria-label="播报阈值" type="range" min="0" max="200" step="5" value={speechThreshold} onChange={e => setSpeechThreshold(Number(e.target.value))}/></label><p className="quiet-note">只有综合分超过阈值才播报。详细度越高，每次播报项数越少；播报项数不等于抽帧频率。速度仅表示画面中的接近趋势，不输出米/秒。</p></fieldset>
        <p className="quiet-note">结合物体类型、方向、粗略远近和接近趋势选择提示；远近只用于风险排序，不提供精确测距或通行判断。</p>
        <div className="consent"><label><input type="checkbox" checked={consent} onChange={e => { setConsent(e.target.checked); if(!e.target.checked) { invalidate('已停止处理'); releaseCamera(); if(source==='camera') setReady(false); else video.current?.pause(); } }}/><span>{health?.provider==='sample' ? '我了解当前为固定样例联调，不能作为真实识别演示。' : '我了解抽帧将发送至百炼云端分析，并同意开始。应用不默认保存图片或视频。'}</span></label></div>
        <div className="actions"><button className="primary" disabled={!permitted} onClick={() => running ? pause() : void start(false)}>{connecting ? <><Camera aria-hidden="true"/>连接摄像头中…</> : running ? <><Pause aria-hidden="true"/>Ⅱ 暂停识别</> : singleOnly ? <><Accessibility aria-hidden="true"/>识别当前环境</> : <><Play aria-hidden="true"/>▶ 开始识别</>}</button><button disabled={!consent || !httpConfigured || connecting || reading || (busy && channel === 'http')} onClick={() => void start(true)}><ScanText aria-hidden="true"/>看牌 · 读取文字</button><button disabled={!consent || !skylightConfigured || !ready || running || connecting || foodBusy || busy} onClick={() => void analyzeSkylight()}><ScanText aria-hidden="true"/>{foodBusy ? '食材识别中…' : 'Skylight · 识别食材'}</button><button className="stop" onClick={() => { invalidate('已停止，摄像头已释放'); releaseCamera(); if(source==='camera') setReady(false); else video.current?.pause(); }}><Square aria-hidden="true"/>停止并释放输入</button></div>
        {skylightConfigured && <fieldset className="source-field"><legend>食材播报详略</legend><label>语音播报内容 <select aria-label="食材语音播报详略" value={foodDetail} onChange={e => changeFoodDetail(e.target.value as FoodDetail)}><option value="brief">简洁 · 只报数量与名称</option><option value="standard">标准 · 名称+新鲜度+挑选</option><option value="detailed">详细 · 含特征与注意</option></select></label><p className="quiet-note">供不同需求选择：需要快速定位选“简洁”，需要充分信息选“详细”。调整后立即生效，浏览器会记住当前为“{foodDetailNames[foodDetail]}”。屏幕展示不受影响。</p></fieldset>}
      </section>
      <div className="workspace">
        <section className="camera-card" aria-label="画面输入">
          <div className="card-heading"><div><p className="section-index">画面</p><h2>观察窗口</h2></div><span className={`status ${running ? 'on' : ''}`}><i/>{connecting ? '连接中' : busy ? '识别中' : running ? '自动观察中' : '待命'}</span></div>
          <div className={`viewport ${ready ? 'has-video' : ''}`}>
            <video ref={video} className={source === 'camera' && projection === 'rectilinear' ? 'camera-flipped' : undefined} muted playsInline controls={source==='video'} onLoadedData={() => setReady(true)} onError={() => { invalidate('输入不可用'); setReady(false); setError('无法解码视频，请使用 H.264 编码的 MP4 文件。'); }} onSeeking={() => { if(sourceRef.current==='video' && !internalSeek.current) invalidate('视频位置已改变，请重新开始'); }} onPause={() => { if(sourceRef.current==='video' && active.current && !internalRead.current) invalidate('视频已暂停，识别同步暂停'); }} onEnded={() => invalidate('视频已结束')} aria-label={sourceNames[source]} />
            {result?.events.some(event => event.box || event.original_box || event.predicted_box) && <svg className={`motion-overlay ${source === 'camera' && projection === 'rectilinear' ? 'camera-flipped-overlay' : ''}`} viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="识别框">
              {result.events.filter(event => event.box || event.original_box || event.predicted_box).map((event, i) => {
                const modelBox = event.original_box ?? event.box;
                const mirrored = source === 'camera' && projection === 'rectilinear';
                const labelX = modelBox ? mirrored ? 1000 - modelBox[2] + 8 : modelBox[0] + 8 : 0;
                return <g key={`${event.label}-${i}`}>
                  <g transform={mirrored ? 'translate(1000 0) scale(-1 1)' : undefined}>
                    {modelBox && <rect className={event.original_box ? 'motion-box-original' : 'motion-box-model'} x={modelBox[0]} y={modelBox[1]} width={modelBox[2]-modelBox[0]} height={modelBox[3]-modelBox[1]}/>}
                    {event.original_box && event.box && <rect className="motion-box-current" x={event.box[0]} y={event.box[1]} width={event.box[2]-event.box[0]} height={event.box[3]-event.box[1]}/>}
                    {event.predicted_box && <rect className="motion-box-predicted" x={event.predicted_box[0]} y={event.predicted_box[1]} width={event.predicted_box[2]-event.predicted_box[0]} height={event.predicted_box[3]-event.predicted_box[1]}/>}
                  </g>
                  {modelBox && <text className="motion-box-label" x={labelX} y={Math.max(22, modelBox[1] - 8)}>{event.text}</text>}
                </g>;
              })}
            </svg>}
            {projection === 'equirectangular' && (trackingEnabled && tracking || overlayTracks.length > 0) && <PanoramaOverlay snapshot={trackingEnabled && tracking ? tracking : undefined} tracks={!trackingEnabled || !tracking ? overlayTracks : undefined} fresh={trackingFreshness.fresh} aspect={video.current?.videoWidth && video.current.videoHeight ? video.current.videoWidth / video.current.videoHeight : 2} />}
            {!ready && <div className="empty-preview"><div className="viewfinder" aria-hidden="true">{source === 'camera' ? <Camera/> : <FileVideo/>}</div><h3>{source==='camera' ? '摄像头尚未开启' : '尚未选择路线视频'}</h3><p>{source==='camera' ? '可先仅本地预览，确认画面后开始识别' : '选择本地 MP4 后开始识别'}</p></div>}
            <span className="source-label">{source==='video' ? 'VIDEO / 回放输入' : 'CAMERA / 实时输入'}</span>
          </div>
          <div className="source-options">{source==='video' ? <label className="file-picker">选择 MP4 视频<input type="file" accept="video/mp4,.mp4" aria-label="选择 MP4 视频" onChange={e => loadVideo(e.target.files?.[0])}/><small>{fileName || '视频仅在本机播放，识别时上传抽帧'}</small></label> : <><label>摄像头<select aria-label="摄像头" value={deviceId} onChange={e => { invalidate('摄像头已切换，请重新开始'); releaseCamera(); setReady(false); setDeviceId(e.target.value); }}><option value="">系统默认摄像头</option>{devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `摄像头 ${i+1}`}</option>)}</select></label><button disabled={connecting} onClick={() => void previewCamera()}>仅本地预览</button><small>{activeCameraLabel ? `当前输入：${activeCameraLabel}` : '支持 USB / 全景摄像头'} · 仅本地预览不会上传画面</small></>}</div>
          {projection === 'equirectangular' && <PanoramaDiagnostics enabled={trackingEnabled} onToggle={toggleTracking} snapshot={tracking} error={trackingError} {...trackingFreshness} sample={health?.provider === 'sample'} />}
          {projection === 'equirectangular' && source === 'video' && <ImuDiagnostics video={video} videoFile={videoFile} />}
        </section>
        <section className="insight-card" aria-label="识别详情"><div className="card-heading"><div><p className="section-index">结果</p><h2>本帧识别详情</h2></div><span className="tag subtle">最多 6 项 · 当前档位最多 {speechDetail === 'low' ? 3 : speechDetail === 'medium' ? 2 : 1} 项播报</span></div>
          <div className="event-list">{result?.events.map((event, i) => <div className="event" key={i}><span className={`event-dot ${event.category}`}/><strong>{event.text}</strong><span>{event.direction_predicted && event.original_direction ? `${directionNames[event.original_direction]}→` : ''}{directionNames[event.direction]}{event.approaching ? " · 疑似靠近" : ""}{event.speed_level && event.speed_level !== 'unknown' ? ` · ${event.speed_level === 'fast' ? '快速' : event.speed_level === 'medium' ? '中速' : '缓慢'}接近` : ""}{event.proximity && event.proximity !== "unknown" ? ` · 本地粗估${{near:"较近",mid:"中距",far:"较远"}[event.proximity]}` : ""}{event.motion_compensated ? ` · 连续跟踪${event.motion_samples ?? 0}帧` : ""}</span></div>)}</div>
          {!result?.events.length && <div className="empty-events"><Info aria-hidden="true"/><p>识别后，这里会列出当前画面中可确认的信息。</p></div>}
          {foodResult && <div className="food-plugin-result" aria-label="Skylight 食材识别结果"><div className="food-plugin-heading"><strong>Skylight 食材识别</strong><span>{foodResult.items.length} 种 · {foodResult.projection === 'equirectangular' ? 'X4 Air 全景' : '当前视角'}</span></div>{foodResult.items.map((item, i) => <article className="food-item" key={`${item.name}-${i}`}><strong>{item.name}</strong><span>{item.description}</span><small>可见新鲜度：{item.freshness_label}（{item.freshness_score}/100）</small><p>挑选：{item.selection_tip}</p><p>注意：{item.warning}</p></article>)}{foodResult.scene_note && <p className="quiet-note">{foodResult.scene_note}</p>}</div>}
          {predictionAudit && <div className={`prediction-audit ${predictionAudit.state}`} role="status" aria-label="预测对播报的影响">
            <div><span>预测对播报的影响</span><strong>{predictionAudit.title}</strong></div>
            <p>{predictionAudit.detail}</p>
            <small>结果延迟 {(predictionAudit.ageMs/1000).toFixed(1)} 秒{predictionAudit.attempted ? ` · 可靠匹配 ${predictionAudit.matched}/${predictionAudit.attempted}` : ''}{result?.events.some(event => event.approaching) ? ' · 连续三帧接近趋势已提升播报优先级' : ''}</small>
          </div>}
          <div className="metrics"><div><span>识别来源</span><strong>{health?.provider==='sample' ? '固定样例' : reading || channel === 'http' ? 'HTTP 抽帧' : '实时连续帧流'}</strong></div><div><span>端到端耗时</span><strong>{roundtrip ? `${(roundtrip/1000).toFixed(1)} s` : '—'}</strong></div><div><span>播报状态</span><strong>{muted ? '已静音' : voiceName ? '中文语音' : '仅文字'}</strong></div></div>
          <p className="quiet-note">只提示当前画面中可确认的信息。没有提示，不代表前方安全。</p>
        </section>
      </div>
      <section className="bottom-grid"><div className="voice-card"><div className="utility-icon" aria-hidden="true"><Headphones/></div><div><h2>语音输出</h2><p>{voiceName || '尚未检测到中文语音。请安装系统中文语音后重启浏览器。'}</p>{voiceError && <p role="alert" className="error">{voiceError}</p>}</div><button onClick={voiceTest} disabled={muted || running || busy}><Volume2 aria-hidden="true"/>测试中文语音</button></div><details className="debug"><summary>运行详情 <span>最近 5 次 · 仅本次会话</span></summary><p>服务：{health?.provider ?? '未连接'} · 模型：{currentModel ?? '—'}</p>{history.length===0 ? <p>尚无识别记录。</p> : history.map(r => <div className="debug-row" key={r.frame_id}>#{r.frame_id} · {r.status} · {r.latency_ms} ms · {r.events.length} 个观察{r.timing && <span> · 图像处理 {r.timing.prepare_ms} ms · 模型 {r.timing.model_ms} ms · 规则 {r.timing.rules_ms} ms</span>}</div>)}<p>不记录图片、密钥或 OCR 全文。</p></details></section>
    </main><footer><span>CityLens · 环境理解辅助工具</span><span>不提供测距、通行判断或安全保证</span></footer>
  </div>;
}
