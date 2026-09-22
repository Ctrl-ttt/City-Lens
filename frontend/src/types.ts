export type Mode = 'walk' | 'read';
export type Source = 'camera' | 'video';
export type Projection = 'rectilinear' | 'equirectangular';
export type Event = { category: 'obstacle' | 'facility' | 'text'; label: string; direction: 'left' | 'front' | 'right' | 'back' | 'above' | 'unknown'; text: string; clarity?: 'high' | 'medium' | 'low' | null; proximity?: 'near' | 'mid' | 'far' | 'unknown'; approaching?: boolean };
export type Speech = { key: string; priority: 'urgent' | 'high' | 'normal' | 'low'; text: string };
export type Analysis = { session_id: string; frame_id: number; status: 'ok' | 'uncertain' | 'error'; events: Event[]; speech: Speech | null; latency_ms: number; error_code?: string; message?: string };
export type Channel = 'http' | 'realtime';
export type Health = {
  status: string; provider: 'live' | 'sample' | 'realtime'; configured: boolean; model: string; sample_scene: string | null;
  http_model: string; http_configured: boolean; realtime_model: string; realtime_configured: boolean;
};
export type RealtimeState = 'waiting' | 'connecting' | 'connected' | 'recovering' | 'disconnected';
export type RealtimeFrame = { type: 'frame'; session_id: string; frame_id: number; mode: 'walk'; source: Source; image: string };
export type RealtimeMessage = { type: 'ready' } | ({ type: 'result' } & Analysis) | { type: 'error'; error_code: string; message: string };
