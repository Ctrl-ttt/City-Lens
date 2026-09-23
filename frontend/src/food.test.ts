import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FoodItem } from './types';
import { buildFoodSpeech, loadFoodDetail, FOOD_DETAIL_STORAGE } from './food';

function item(overrides: Partial<FoodItem> = {}): FoodItem {
  return {
    name: '黄瓜', description: '表皮带刺、颜色翠绿', confidence: 0.9,
    freshness_score: 82, freshness_label: '外观新鲜',
    selection_tip: '选硬挺、不发蔫的', warning: '仅供视觉参考',
    ...overrides,
  };
}

describe('buildFoodSpeech', () => {
  it('reports nothing to confirm when there are no items', () => {
    expect(buildFoodSpeech([], 'standard')).toBe('当前画面没有可确认的食材。');
  });
  it('brief speaks only the count and names', () => {
    const speech = buildFoodSpeech([item({ name: '生菜' }), item({ name: '黄瓜' })], 'brief');
    expect(speech).toBe('识别到 2 种食材：生菜、黄瓜。');
    expect(speech).not.toContain('挑选建议');
  });
  it('standard adds freshness and selection tips but omits features and warnings', () => {
    const speech = buildFoodSpeech([item()], 'standard');
    expect(speech).toContain('可见新鲜度 82 分，外观新鲜');
    expect(speech).toContain('挑选建议：选硬挺、不发蔫的');
    expect(speech).not.toContain('特征');
    expect(speech).not.toContain('注意');
  });
  it('detailed adds visible features and warnings', () => {
    const speech = buildFoodSpeech([item()], 'detailed');
    expect(speech).toContain('特征：表皮带刺、颜色翠绿');
    expect(speech).toContain('注意：仅供视觉参考');
  });
  it('detailed skips empty feature and warning segments', () => {
    const speech = buildFoodSpeech([item({ description: '', warning: '' })], 'detailed');
    expect(speech).not.toContain('特征');
    expect(speech).not.toContain('注意');
  });
});

describe('loadFoodDetail', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('defaults to standard when nothing is stored', () => {
    vi.stubGlobal('localStorage', { getItem: () => null } as unknown as Storage);
    expect(loadFoodDetail()).toBe('standard');
  });
  it('returns a stored valid preference', () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => (key === FOOD_DETAIL_STORAGE ? 'detailed' : null) } as unknown as Storage);
    expect(loadFoodDetail()).toBe('detailed');
  });
  it('falls back to standard for an unrecognized stored value', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'verbose' } as unknown as Storage);
    expect(loadFoodDetail()).toBe('standard');
  });
  it('falls back to standard when storage access throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } } as unknown as Storage);
    expect(loadFoodDetail()).toBe('standard');
  });
});
