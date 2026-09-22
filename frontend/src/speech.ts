import type { Speech } from './types';
export type Candidate = Speech & { session: string; capturedAt: number; maxAge: number; manual?: boolean };
export interface VoiceDriver { speak(text: string, done: () => void): void; cancel(): void }
const rank = { high: 3, normal: 2, low: 1 };

/** Bounded queue (one newest candidate), deduplication, and generation checks. */
export class SpeechQueue {
  private current: Candidate | null = null;
  private pending: Candidate | null = null;
  private spoken = new Map<string, number>();
  private generation = 0;
  private muted = false;
  constructor(private driver: VoiceDriver, private session: () => string, private now = () => Date.now()) {}
  private valid(c: Candidate) {
    return !this.muted && c.session === this.session() && this.now() - c.capturedAt <= c.maxAge;
  }
  offer(c: Candidate) {
    if (!this.valid(c)) return;
    if (!c.manual && this.spoken.has(c.key) && this.now() - this.spoken.get(c.key)! < 4000) return;
    if (this.current) {
      if (c.manual || rank[c.priority] > rank[this.current.priority]) this.cancelPlayback();
      else { this.pending = c; return; }
    }
    this.start(c);
  }
  private start(c: Candidate) {
    if (!this.valid(c)) return;
    this.current = c;
    this.spoken.set(c.key, this.now());
    // Keep memory bounded on long OCR sessions.
    for (const [key, time] of this.spoken) if (this.now() - time > 4000) this.spoken.delete(key);
    const generation = ++this.generation;
    this.driver.speak(c.text, () => {
      if (generation !== this.generation) return;
      this.current = null;
      const next = this.pending;
      this.pending = null;
      if (next) this.offer(next);
    });
  }
  private cancelPlayback() {
    this.generation++;
    this.current = null;
    this.pending = null;
    this.driver.cancel();
  }
  clear() { this.cancelPlayback(); this.spoken.clear(); }
  mute(value: boolean) { this.muted = value; if (value) this.cancelPlayback(); }
}

export function chineseVoice(): SpeechSynthesisVoice | undefined {
  if (!('speechSynthesis' in window)) return undefined;
  const voices = window.speechSynthesis.getVoices().filter(v => /^zh/i.test(v.lang));
  return voices.find(v => v.localService) ?? voices[0];
}

export function browserVoiceDriver(onError: () => void): VoiceDriver {
  return {
    speak(text, done) {
      const voice = chineseVoice();
      if (!voice) { onError(); done(); return; }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.rate = 1;
      utterance.onend = done;
      utterance.onerror = e => { if (!['canceled', 'interrupted'].includes(e.error)) onError(); done(); };
      window.speechSynthesis.speak(utterance);
    },
    cancel() { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); },
  };
}
