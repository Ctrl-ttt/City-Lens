import { useEffect, useRef, useState } from 'react';
import type { Analysis, Health, Mode, Source } from './types';
import { SessionGate } from './session';
import { SpeechQueue, browserVoiceDriver, chineseVoice, type Candidate } from './speech';

const sourceNames = { camera: '实时摄像头', video: '路线视频回放' };
const directionNames = { left: '左前方', front: '前方', right: '右前方', unknown: '画面中' };

export default function App() {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const objectUrl = useRef<string | null>(null);
  const gate = useRef(new SessionGate());
  const active = useRef(false);
  const sourceRef = useRef<Source>('camera');
  const internalSeek = useRef(false);
  const queue = useRef<SpeechQueue | null>(null);
  const last = useRef<Candidate | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState('');
  const [source, setSource] = useState<Source>('camera');
  const [mode, setMode] = useState<Mode>('walk');
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
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<Analysis | null>(null);
  const [history, setHistory] = useState<Analysis[]>([]);
  const [roundtrip, setRoundtrip] = useState(0);
  const [singleOnly, setSingleOnly] = useState(false);

  if (!queue.current) queue.current = new SpeechQueue(browserVoiceDriver(() => setVoiceError('语音播放失败，请检查系统中文语音和输出设备。')), () => gate.current.session);

  async function checkHealth() {
    try {
      const response = await fetch('/api/health', { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error();
      const value: Health = await response.json();
      if (!['live', 'sample'].includes(value.provider)) throw new Error();
      setHealth(value); setHealthError('');
    } catch { setHealth(null); setHealthError('后端未连接，请运行启动脚本后重新检查。'); }
  }

  function invalidate(message?: string) {
    active.current = false; setRunning(false); setBusy(false);
    gate.current.reset(); queue.current?.clear(); last.current = null;
    setResult(null); setHistory([]); setRoundtrip(0);
    if (message) setNotice(message);
  }
  function releaseCamera() {
    stream.current?.getTracks().forEach(t => { t.onended = null; t.stop(); });
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }
  function changeSource(next: Source) {
    invalidate('输入已切换，请重新开始'); releaseCamera();
    if (video.current) { video.current.pause(); video.current.removeAttribute('src'); video.current.load(); }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null; setFileName(''); setReady(false); setError('');
    sourceRef.current = next; setSource(next);
  }
  function pause() {
    invalidate('已暂停。按开始恢复识别');
    if (sourceRef.current === 'video') video.current?.pause();
  }
  function failure(message: string) {
    queue.current?.clear(); last.current = null; setResult(null); setRoundtrip(0);
    setNotice('本次识别不可用，请重新观察当前画面');
    if (gate.current.failed()) { invalidate('已暂停自动识别'); setError(`${message} 连续三次失败，请检查后重新开始。`); }
    else setError(message);
  }

  useEffect(() => {
    void checkHealth();
    const refreshVoices = () => { setVoiceName(chineseVoice()?.name ?? ''); };
    refreshVoices();
    window.speechSynthesis?.addEventListener('voiceschanged', refreshVoices);
    const onHidden = () => { if (document.hidden) invalidate('页面进入后台，识别已暂停'); };
    document.addEventListener('visibilitychange', onHidden);
    const timer = setInterval(() => { if (active.current) void analyze('walk'); }, 2000);
    return () => {
      clearInterval(timer); gate.current.reset(); queue.current?.clear(); releaseCamera();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      document.removeEventListener('visibilitychange', onHidden);
      window.speechSynthesis?.removeEventListener('voiceschanged', refreshVoices);
    };
  }, []);

  async function prepareCamera(): Promise<boolean> {
    if (stream.current && video.current?.readyState && video.current.readyState >= 2) return true;
    const session = gate.current.session;
    setConnecting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera unavailable');
      const media = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (gate.current.session !== session || sourceRef.current !== 'camera') { media.getTracks().forEach(t => t.stop()); return false; }
      stream.current = media;
      media.getVideoTracks()[0].onended = () => { invalidate('摄像头已断开'); releaseCamera(); setReady(false); setError('请重新连接摄像头，然后开始识别。'); };
      video.current!.srcObject = media;
      await video.current!.play();
      if (gate.current.session !== session) { releaseCamera(); return false; }
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'));
      setReady(true); return true;
    } catch {
      if (gate.current.session === session) { releaseCamera(); setReady(false); setError('摄像头不可用：请允许浏览器访问，并检查 USB 连接及是否被其它软件占用。'); }
      return false;
    } finally { setConnecting(false); }
  }

  async function start(readMode = false, once = false) {
    if (!consent || !health?.configured || connecting) return;
    invalidate(); setError('');
    const requestedMode: Mode = readMode ? 'read' : 'walk';
    setMode(requestedMode);
    const session = gate.current.session;
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
        } catch { setError('视频无法回到开头，请重新选择文件。'); return; }
        finally { internalSeek.current = false; }
      }
      if (readMode || once || singleOnly) video.current.pause();
      else { try { await video.current.play(); } catch { setError('视频无法播放，请检查视频格式。'); return; } }
    }
    if (session !== gate.current.session) return;
    active.current = !readMode && !once && !singleOnly;
    setRunning(active.current); setNotice(readMode ? '正在读取标牌' : '正在观察当前画面');
    await analyze(requestedMode);
  }

  async function analyze(requestedMode: Mode) {
    const element = video.current;
    if (!element || element.readyState < 2 || element.videoWidth === 0) return;
    const ticket = gate.current.acquire(Date.now());
    if (!ticket) return;
    setBusy(true);
    const maxAge = requestedMode === 'walk' ? 6000 : 8000;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, (requestedMode === 'read' ? 1280 : 960) / Math.max(element.videoWidth, element.videoHeight));
    canvas.width = Math.round(element.videoWidth * scale); canvas.height = Math.round(element.videoHeight * scale);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      canvas.getContext('2d')!.drawImage(element, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.75));
      if (!gate.current.current(ticket)) return;
      if (!blob) throw new Error('无法读取当前画面，请重新选择输入。');
      const form = new FormData();
      form.append('image', blob, 'frame.jpg'); form.append('mode', requestedMode); form.append('source', sourceRef.current);
      form.append('session_id', ticket.session); form.append('frame_id', String(ticket.frame));
      timer = setTimeout(() => ticket.controller.abort(), 9000);
      const response = await fetch('/api/analyze', { method: 'POST', body: form, signal: ticket.controller.signal });
      const data: Analysis = await response.json();
      if (!gate.current.current(ticket)) return;
      if (!response.ok || data.status === 'error') throw new Error(data.message || '识别服务不可用，请稍后重试。');
      if (data.session_id !== ticket.session || data.frame_id !== ticket.frame || !Array.isArray(data.events)) throw new Error('响应不匹配，请重新观察。');
      if (!gate.current.fresh(ticket, Date.now(), maxAge)) { failure('结果已过期，本次内容未播报。可切换按键识别。'); return; }
      gate.current.succeeded(); setError(''); setResult(data); setRoundtrip(Date.now()-ticket.capturedAt);
      setHistory(items => [data, ...items].slice(0, 5));
      setNotice(data.speech?.text ?? (data.status === 'uncertain' ? '画面不清晰，请调整拍摄角度' : '本帧没有可确认的提示；不代表通行安全'));
      if (data.speech) {
        const candidate = { ...data.speech, session: ticket.session, capturedAt: ticket.capturedAt, maxAge, manual: requestedMode === 'read' };
        last.current = candidate; queue.current?.offer(candidate);
      } else last.current = null;
    } catch (reason) {
      if (!gate.current.current(ticket)) return;
      failure(reason instanceof DOMException && reason.name === 'AbortError' ? '识别超时，请检查网络。' : reason instanceof Error ? reason.message : '识别失败，请重试。');
    } finally {
      if (timer) clearTimeout(timer);
      canvas.width = canvas.height = 0;
      gate.current.finish(ticket);
      if (gate.current.current(ticket)) setBusy(false);
    }
  }

  function loadVideo(file?: File) {
    if (!file) return;
    invalidate('视频已选择，请开始识别'); releaseCamera(); setError(''); setReady(false);
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(file); setFileName(file.name);
    video.current!.src = objectUrl.current; video.current!.load();
  }
  function replay() {
    if (!last.current) return;
    queue.current?.offer({ ...last.current, text: `上一条提示：${last.current.text}`, capturedAt: Date.now(), maxAge: 8000, manual: true });
  }
  function toggleMute() { const next = !muted; setMuted(next); queue.current?.mute(next); }
  function voiceTest() {
    if (!voiceName) { setVoiceError('未发现中文语音。请在 Windows 语言设置安装中文语音后重启浏览器。'); return; }
    setVoiceError('');
    queue.current?.offer({ key: 'voice-test', priority: 'normal', text: 'CityLens 中文语音测试。请确认可以听到这句话。', session: gate.current.session, capturedAt: Date.now(), maxAge: 8000, manual: true });
  }
  const permitted = consent && !!health?.configured && !connecting;

  return <div className="shell">
    <a className="skip" href="#controls">跳转到操作区</a>
    <header className="header"><a className="brand" href="#"><span className="lens-mark" aria-hidden="true">◉</span><span>CityLens<small>看见城市，听见线索</small></span></a><div className="header-meta"><span className="tag">AI + 社会公益</span><span className="version">原型 v0.1</span></div></header>
    <main>
      <section className="intro"><div><p className="eyebrow">YOUR CITY, A LITTLE CLEARER</p><h1>让重要的信息，<br/><span>被听见。</span></h1><p className="intro-copy">面向视障与低视力人群的城市环境理解原型。<br/>观察当前画面，听取简短提示，按需读取标牌。</p></div><div className="intro-note"><span className="note-number">01 / OBSERVE</span><p>先观察，再理解。</p><small>提示方向以相机画面为准<br/>不提供测距或通行决策</small></div></section>
      {health?.provider === 'sample' && <div className="banner sample" role="status"><strong>样例联调模式 · 不是实际识别</strong><span>结果来自固定样例，不分析输入画面；不会发送至云端。场景：{health.sample_scene}</span></div>}
      {(healthError || (health && !health.configured)) && <div className="banner warning"><span>{healthError || '模型尚未配置。请在后端 .env 配置 API，再重新检查。'}</span><button onClick={() => void checkHealth()}>重新检查</button></div>}
      <div className="workspace">
        <section className="camera-card" aria-label="画面输入">
          <div className="card-heading"><h2>观察窗口</h2><span className={`status ${running ? 'on' : ''}`}><i/>{connecting ? '连接中' : busy ? '识别中' : running ? '自动观察中' : '待命'}</span></div>
          <div className="source-tabs" role="group" aria-label="输入来源"><button aria-pressed={source==='camera'} onClick={() => changeSource('camera')}>实时摄像头</button><button aria-pressed={source==='video'} onClick={() => changeSource('video')}>路线视频回放</button></div>
          <div className={`viewport ${ready ? 'has-video' : ''}`}>
            <video ref={video} muted playsInline controls={source==='video'} onLoadedData={() => setReady(true)} onError={() => { invalidate('输入不可用'); setReady(false); setError('无法解码视频，请使用 H.264 编码的 MP4 文件。'); }} onSeeking={() => { if(sourceRef.current==='video' && !internalSeek.current) invalidate('视频位置已改变，请重新开始'); }} onPause={() => { if(sourceRef.current==='video' && active.current) invalidate('视频已暂停，识别同步暂停'); }} onEnded={() => invalidate('视频已结束')} aria-label={sourceNames[source]} />
            {!ready && <div className="empty-preview"><div className="viewfinder" aria-hidden="true"><span>◎</span></div><h3>{source==='camera' ? '准备好，看看周围' : '从一段路线开始'}</h3><p>{source==='camera' ? '点击开始后，允许浏览器使用摄像头' : '选择本地 MP4，使用同一条 AI 识别链路'}</p></div>}
            <span className="source-label">{source==='video' ? 'VIDEO / 回放输入' : 'CAMERA / 实时输入'}</span>
          </div>
          <div className="source-options">{source==='video' ? <label className="file-picker">选择 MP4 视频<input type="file" accept="video/mp4,.mp4" aria-label="选择 MP4 视频" onChange={e => loadVideo(e.target.files?.[0])}/><small>{fileName || '视频仅在本机播放，识别时上传抽帧'}</small></label> : <><label>摄像头<select aria-label="摄像头" value={deviceId} onChange={e => { invalidate('摄像头已切换，请重新开始'); releaseCamera(); setReady(false); setDeviceId(e.target.value); }}><option value="">系统默认摄像头</option>{devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `摄像头 ${i+1}`}</option>)}</select></label><small>支持 Link 2 / USB 摄像头 · 画面不镜像</small></>}</div>
        </section>
        <section className="insight-card" aria-label="环境提示"><div className="card-heading"><h2>此刻的重点</h2><span className="tag subtle">{mode==='walk' ? '环境提示' : '看牌模式'}</span></div>
          <div className="insight-main"><span className="sound-symbol" aria-hidden="true">◖ )))</span><p className="live-caption" role="status" aria-live={muted || !voiceName ? 'polite' : 'off'}>{notice}</p>{error && <p className="error" role="alert">{error}</p>}</div>
          <div className="event-list">{result?.events.map((event, i) => <div className="event" key={i}><span className={`event-dot ${event.category}`}/><strong>{event.text}</strong><span>{directionNames[event.direction]}</span></div>)}</div>
          <div className="metrics"><div><span>识别来源</span><strong>{health?.provider==='sample' ? '固定样例' : '千问视觉模型'}</strong></div><div><span>端到端耗时</span><strong>{roundtrip ? `${(roundtrip/1000).toFixed(1)} s` : '—'}</strong></div><div><span>播报状态</span><strong>{muted ? '已静音' : voiceName ? '中文语音' : '仅文字'}</strong></div></div>
          <p className="quiet-note">只提示当前画面中可确认的信息。没有提示，不代表前方安全。</p>
        </section>
      </div>
      <section className="control-card" id="controls" aria-label="识别操作"><div className="control-top"><div><h2>按你的节奏，了解环境</h2><p>环境提示自动观察；看牌由你主动触发。</p></div><label className="switch-label"><input type="checkbox" checked={singleOnly} onChange={e => { invalidate('识别方式已切换'); setSingleOnly(e.target.checked); }}/>只用按键识别</label></div>
        <div className="actions"><button className="primary" disabled={!permitted} onClick={() => running ? pause() : void start(false)}>{connecting ? '连接摄像头中…' : running ? 'Ⅱ 暂停识别' : mode==='read' ? '▶ 返回环境识别' : singleOnly ? '识别当前环境' : '▶ 开始识别'}</button><button disabled={!permitted || busy} onClick={() => void start(true)}>看牌 · 读取文字</button><button disabled={!last.current || muted || !voiceName} onClick={replay}>重播上一条</button><button aria-pressed={muted} onClick={toggleMute}>{muted ? '取消静音' : '静音'}</button><button className="stop" onClick={() => { invalidate('已停止，摄像头已释放'); releaseCamera(); if(source==='camera') setReady(false); else video.current?.pause(); }}>停止并释放输入</button></div>
        <div className="consent"><label><input type="checkbox" checked={consent} onChange={e => { setConsent(e.target.checked); if(!e.target.checked) { invalidate('已停止处理'); releaseCamera(); if(source==='camera') setReady(false); else video.current?.pause(); } }}/><span>{health?.provider==='sample' ? '我了解当前为固定样例联调，不能作为真实识别演示。' : '我了解抽帧将发送至百炼云端分析，并同意开始。应用不默认保存图片或视频。'}</span></label></div>
      </section>
      <section className="bottom-grid"><div className="voice-card"><h2>先听一下</h2><p>{voiceName || '尚未检测到中文语音。请安装系统中文语音后重启浏览器。'}</p>{voiceError && <p role="alert" className="error">{voiceError}</p>}<button onClick={voiceTest} disabled={muted || running || busy}>测试中文语音</button></div><details className="debug"><summary>运行详情 <span>最近 5 次 · 仅本次会话</span></summary><p>服务：{health?.provider ?? '未连接'} · 模型：{health?.model ?? '—'}</p>{history.length===0 ? <p>尚无识别记录。</p> : history.map(r => <div className="debug-row" key={r.frame_id}>#{r.frame_id} · {r.status} · {r.latency_ms} ms · {r.events.length} 个观察</div>)}<p>不记录图片、密钥或 OCR 全文。</p></details></section>
    </main><footer><span>CityLens / 城市环境理解助手</span><span>辅助理解原型 · 不替代专业无障碍设备</span></footer>
  </div>;
}
