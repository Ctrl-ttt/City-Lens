export type Mode = 'walk' | 'read';
export type Source = 'camera' | 'video';
export type Event = { category: 'obstacle' | 'facility' | 'text'; label: string; direction: 'left' | 'front' | 'right' | 'unknown'; text: string };
export type Speech = { key: string; priority: 'high' | 'normal' | 'low'; text: string };
export type Analysis = { session_id: string; frame_id: number; status: 'ok' | 'uncertain' | 'error'; events: Event[]; speech: Speech | null; latency_ms: number; error_code?: string; message?: string };
export type Health = { status: string; provider: 'live' | 'sample'; configured: boolean; model: string; sample_scene: string | null };
