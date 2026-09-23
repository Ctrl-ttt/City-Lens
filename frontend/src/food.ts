import type { FoodDetail, FoodItem } from './types';

export const FOOD_DETAIL_STORAGE = 'citylens-food-detail';
export const foodDetailNames: Record<FoodDetail, string> = { brief: '简洁', standard: '标准', detailed: '详细' };

export function loadFoodDetail(): FoodDetail {
  try {
    const value = localStorage.getItem(FOOD_DETAIL_STORAGE);
    if (value === 'brief' || value === 'standard' || value === 'detailed') return value;
  } catch { /* private mode blocks storage; fall back to session default */ }
  return 'standard';
}

// Screen-reader users pick how much a food round speaks; visuals stay unchanged.
export function buildFoodSpeech(items: FoodItem[], level: FoodDetail): string {
  if (!items.length) return '当前画面没有可确认的食材。';
  if (level === 'brief') return `识别到 ${items.length} 种食材：${items.map(item => item.name).join('、')}。`;
  const parts = items.map(item => {
    const freshness = `可见新鲜度 ${item.freshness_score} 分，${item.freshness_label}`;
    if (level === 'detailed') {
      const feature = item.description ? `。特征：${item.description}` : '';
      const warning = item.warning ? `。注意：${item.warning}` : '';
      return `${item.name}${feature}。${freshness}。挑选建议：${item.selection_tip}${warning}`;
    }
    return `${item.name}，${freshness}。挑选建议：${item.selection_tip}`;
  });
  return `识别到 ${items.length} 种食材。` + parts.join('；');
}
