import { useEffect, useRef, useState } from 'react';

type Device = { id: string; name: string };
type CameraState = {
  ptz: { pan: number; tilt: number } | null;
  zoom: { min: number; max: number; step: number; value: number } | null;
  autofocus: boolean | null;
};
export function isLink2(label: string) {
  const name = label.replace(/\s*\([^)]*\)\s*$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return name === 'insta360link2' || name === 'link2';
}
async function request(body?: Record<string, unknown>) {
  const response = await fetch('/api/camera/link2', {
    method: body ? 'POST' : 'GET',
    headers: { 'X-CityLens-Camera': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Link 2 暂不可用，请重新检查。');
  return data;
}

export default function Link2Controls({ activeLabel, cameraLabels, beforeControl, onControlBusyChange }: {
  activeLabel: string; cameraLabels: string[]; beforeControl: () => void;
  onControlBusyChange: (busy: boolean) => void;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [state, setState] = useState<CameraState | null>(null);
  const [message, setMessage] = useState('正在检查 Link 2 控制组件…');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pan, setPan] = useState(0);
  const [tilt, setTilt] = useState(0);
  const [zoom, setZoom] = useState(0);
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const pendingRefresh = useRef<(() => Promise<void>) | null>(null);
  const browserCount = cameraLabels.filter(isLink2).length;
  const matched = isLink2(activeLabel) && browserCount === 1;
  const enabled = matched && devices.length === 1 && !busy;

  function finish(ticket: number) {
    inFlight.current = false;
    if (ticket === epoch.current) setBusy(false);
    const next = pendingRefresh.current;
    pendingRefresh.current = null;
    if (next) void next();
  }

  async function refresh() {
    const ticket = ++epoch.current;
    if (inFlight.current) { pendingRefresh.current = refresh; return; }
    inFlight.current = true; setBusy(true); setError(''); setState(null);
    try {
      const list: { devices: Device[] } = await request();
      if (ticket !== epoch.current) return;
      setDevices(list.devices);
      setMessage(list.devices.length ? `已检测到 ${list.devices.length} 台 Link 2` : '控制组件已就绪，尚未检测到 Link 2。请连接 USB 后刷新。');
      if (matched && list.devices.length === 1) {
        const next: CameraState = await request({ device_id: list.devices[0].id, action: 'status' });
        if (ticket !== epoch.current) return;
        setState(next); setPan(Math.round(next.ptz?.pan ?? 0)); setTilt(Math.round(next.ptz?.tilt ?? 0)); setZoom(next.zoom?.value ?? 0);
      }
    } catch (reason) {
      if (ticket === epoch.current) { setDevices([]); setMessage('Link 2 控制暂不可用'); setError(reason instanceof Error ? reason.message : '检查失败，请重试。'); }
    } finally { finish(ticket); }
  }

  useEffect(() => {
    void refresh();
    return () => { ++epoch.current; pendingRefresh.current = null; };
  }, [activeLabel, browserCount]);

  async function control(action: string, values: Record<string, unknown>) {
    if (!enabled || inFlight.current || document.hidden) return;
    const ticket = epoch.current;
    inFlight.current = true; setBusy(true); setError('');
    onControlBusyChange(true);
    // A changed view invalidates prior directional guidance and in-flight analysis.
    beforeControl();
    try {
      await request({ device_id: devices[0].id, action, ...values });
      if (ticket === epoch.current) {
        setState(null);
        setMessage('指令已接收。请确认画面调整完成，刷新相机状态后再操作或开始识别。');
      }
    } catch (reason) {
      if (ticket === epoch.current) { setState(null); setMessage('请刷新相机状态后重试。'); setError(reason instanceof Error ? reason.message : '操作失败，请重试。'); }
    } finally {
      onControlBusyChange(false);
      finish(ticket);
    }
  }

  return <details className="link2-panel">
    <summary>Link 2 相机控制</summary>
    <p role="status">{message}</p>
    {error && <p className="error" role="alert">{error}</p>}
    <button disabled={busy} onClick={() => void refresh()}>{busy ? '正在连接相机…' : '刷新 Link 2 状态'}</button>
    {!matched && <p className="quiet-note">先在摄像头列表中选择 Link 2，点击“仅本地预览”确认画面。</p>}
    {(devices.length > 1 || browserCount > 1) && <p className="quiet-note">检测到多台 Link 2。为确保控制的是当前画面，请只连接一台后刷新。</p>}
    {state && <>
      <p className="quiet-note">调整会暂停识别；确认画面稳定后，请重新开始。云台角度是设备坐标。</p>
      <fieldset disabled={!enabled || !state.ptz}>
        <legend>云台角度（度）</legend>
        <div className="link2-fields">
          <label>水平（−145～145）<input aria-label="Link 2 水平角度" type="number" min={-145} max={145} step={1} value={Number.isNaN(pan) ? '' : pan} onChange={e => setPan(e.target.valueAsNumber)}/></label>
          <label>俯仰（−45～90）<input aria-label="Link 2 俯仰角度" type="number" min={-45} max={90} step={1} value={Number.isNaN(tilt) ? '' : tilt} onChange={e => setTilt(e.target.valueAsNumber)}/></label>
        </div>
        <button disabled={!Number.isInteger(pan) || !Number.isInteger(tilt) || pan < -145 || pan > 145 || tilt < -45 || tilt > 90} onClick={() => void control('ptz', { pan, tilt })}>应用云台角度</button>
        <button onClick={() => void control('ptz', { pan: 0, tilt: 0 })}>云台回正</button>
        {!state.ptz && <p>当前设备未返回云台状态。</p>}
      </fieldset>
      <fieldset disabled={!enabled || !state.zoom}>
        <legend>变焦</legend>
        {state.zoom ? <label>变焦值（相机范围 {state.zoom.min}～{state.zoom.max}）<input aria-label="Link 2 变焦" type="range" min={state.zoom.min} max={state.zoom.max} step={state.zoom.step} value={zoom} onChange={e => setZoom(Number(e.target.value))}/><output>{zoom}</output></label> : <p>当前设备未返回变焦范围。</p>}
        <button onClick={() => void control('zoom', { zoom })}>应用变焦</button>
      </fieldset>
      <button disabled={!enabled || state.autofocus === null} onClick={() => void control('autofocus', { enabled: !state.autofocus })}>{state.autofocus ? '关闭自动对焦' : '开启自动对焦'}</button>
    </>}
  </details>;
}
