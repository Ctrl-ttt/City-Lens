import { test, expect } from '@playwright/test';

test('slow HTTP inference captures fresh frames promptly after completion without overlapping', async ({ page }) => {
  const starts: number[] = [], ends: number[] = [];
  let pending = 0, peak = 0;
  await page.route('**/api/analyze', async route => {
    starts.push(Date.now()); pending++; peak = Math.max(peak, pending);
    const response = await route.fetch();
    await new Promise(resolve => setTimeout(resolve, 2300));
    ends.push(Date.now()); pending--;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.goto('/');
  await page.getByRole('checkbox', { name: /我了解当前/ }).check();
  await page.getByRole('button', { name: '▶ 开始识别' }).click();
  await expect.poll(() => starts.length, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
  await page.getByRole('button', { name: '停止并释放输入' }).click();
  const gaps = starts.slice(1, 3).map((at, i) => at - ends[i]);
  expect(peak).toBe(1);
  expect(Math.max(...gaps)).toBeLessThan(600);
  const count = starts.length;
  await page.waitForTimeout(2300);
  expect(starts.length).toBe(count);
});

test('HTTP stage timings are visible for diagnosing the actual bottleneck', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('checkbox', { name: /我了解当前/ }).check();
  await page.getByRole('checkbox', { name: '只用按键识别' }).check();
  await page.getByRole('button', { name: '识别当前环境', exact: true }).click();
  await expect(page.locator('.live-caption')).toHaveText('右侧发现楼梯');
  await page.locator('.debug summary').click();
  await expect(page.locator('.debug-row').first()).toContainText('图像处理');
  await expect(page.locator('.debug-row').first()).toContainText('模型');
});
