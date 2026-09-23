export type Mode = 'walk' | 'read';
export type Source = 'camera' | 'video';
export type Projection = 'rectilinear' | 'equirectangular';
export type SpeechDetailLevel = 'low' | 'medium' | 'high';
export type Event = { category: 'obstacle' | 'facility' | 'text'; label: string; direction: 'left' | 'front' | 'right' | 'back' | 'above' | 'unknown'; original_direction?: 'left' | 'front' | 'right' | 'back' | 'above' | 'unknown'; text: string; clarity?: 'high' | 'medium' | 'low' | null; box?: [number, number, number, number] | null; original_box?: [number, number, number, number] | null; predicted_box?: [number, number, number, number] | null; proximity?: 'near' | 'mid' | 'far' | 'unknown'; approaching?: boolean; approach_rate?: number | null; speed_level?: 'unknown' | 'slow' | 'medium' | 'fast'; motion_compensated?: boolean; direction_predicted?: boolean; motion_samples?: number; forecast_seconds?: number; view?: 'front' | 'left' | 'right' | 'back' | 'up' | 'down' | null };
export type Speech = { key: string; priority: 'urgent' | 'high' | 'normal' | 'low'; text: string };
export type Analysis = { session_id: string; frame_id: number; status: 'ok' | 'uncertain' | 'error'; events: Event[]; speech: Speech | null; latency_ms: number; timing?: { prepare_ms: number; model_ms: number; rules_ms: number } | null; error_code?: string; message?: string };
export type SignResult = { text: string; clarity: 'high' | 'medium'; direction: 'left' | 'front' | 'right' | 'back' | 'above' | 'unknown'; box?: [number, number, number, number] | null };
export type ReadAnalysis = { session_id: string; frame_id: number; status: 'ok' | 'uncertain' | 'error'; sign: SignResult | null; speech: Speech | null; latency_ms: number; error_code?: string; message?: string };
export type Channel = 'http' | 'realtime';
export type Health = {
  status: string; provider: 'live' | 'sample' | 'realtime'; configured: boolean; model: string; sample_scene: string | null;
  http_model: string; http_configured: boolean; read_model?: string; realtime_model: string; realtime_configured: boolean; camera_hfov_deg?: number; speech_score_threshold?: number; speech_detail_level?: SpeechDetailLevel;
  plugins?: { skylight?: { enabled: boolean; configured: boolean; model: string } };
};
export type FoodItem = {
  name: string; description: string; confidence: number; freshness_score: number;
  freshness_label: string; selection_tip: string; warning: string;
};
export type FoodResult = { items: FoodItem[]; scene_note: string; projection: Projection; latency_ms: number };
export type FoodDetail = 'brief' | 'standard' | 'detailed';
export type RealtimeState = 'waiting' | 'connecting' | 'connected' | 'recovering' | 'disconnected';
export type RealtimeFrame = { type: 'frame'; session_id: string; frame_id: number; mode: 'walk'; source: Source; image: string; speech_threshold?: number; speech_detail_level?: SpeechDetailLevel };
export type RealtimeMessage = { type: 'ready' } | ({ type: 'result' } & Analysis) | { type: 'error'; error_code: string; message: string };
