import { test, expect, type Page } from '@playwright/test';

// 显示模式是新增的无障碍开关，这里锁定它的行为与配色契约。
async function ready(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('checkbox', { name: /我了解当前/ }).check();
}

test('large text and high contrast toggles change typography and palette', async ({ page }) => {
  await ready(page);
  const shell = page.locator('.shell');
  const caption = page.locator('.live-caption');
  const base = await caption.evaluate(el => parseFloat(getComputedStyle(el).fontSize));

  await page.getByRole('button', { name: '大字' }).click();
  await expect(shell).toHaveClass(/large-text/);
  const large = await caption.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  expect(large).toBeGreaterThan(base);
  await page.getByRole('button', { name: '大字' }).click();
  await expect(shell).not.toHaveClass(/large-text/);
  expect(await caption.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBe(base);

  await page.getByRole('button', { name: '高对比' }).click();
  await expect(shell).toHaveClass(/high-contrast/);
  await expect.poll(() => shell.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
  await expect.poll(() => shell.evaluate(el => getComputedStyle(el).color)).toBe('rgb(0, 0, 0)');
  await expect.poll(() => page.locator('.now-panel').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 0, 0)');
  await expect.poll(() => page.locator('.actions .primary').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 0, 0)');
  await expect.poll(() => page.locator('.voice-card').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByRole('button', { name: '高对比' }).click();
  await expect(shell).not.toHaveClass(/high-contrast/);
});

test('camera placeholder stays inside the preview frame at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  const overflow = await page.locator('.viewport').evaluate(el => {
    const preview = el.querySelector('.empty-preview') as HTMLElement;
    return Math.ceil(preview.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom);
  });
  expect(overflow).toBeLessThanOrEqual(0);
});
