import { test, expect } from '@playwright/test';
import { readState } from '../scripts/env.mjs';

const { webUrl } = readState();

for (const width of [320, 390, 768, 860, 900, 1440]) {
  test(`顶部官网入口在 ${width}px 下位于关于右侧且无溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/', '/about']) {
      await page.goto(`${webUrl}${path}`);
      const nav = page.getByRole('navigation', { name: '站点导航', exact: true });
      const about = nav.getByRole('link', { name: '关于我们' });
      const official = nav.getByRole('link', { name: '返回官网' });
      await expect(official).toBeVisible();
      await expect(official).toHaveAttribute('href', 'https://empact.cn/');
      const aboutBox = await about.boundingBox();
      const officialBox = await official.boundingBox();
      expect(officialBox!.x).toBeGreaterThanOrEqual(aboutBox!.x + aboutBox!.width);
      expect(officialBox!.y).toBe(aboutBox!.y);
      expect(officialBox!.x + officialBox!.width).toBeLessThanOrEqual(width);
      expect(await nav.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await official.focus();
      await expect(official).toBeFocused();
      await expect(official).toHaveCSS('outline-style', 'solid');
      await expect(page.getByRole('navigation', { name: '页脚导航' }).getByRole('link', {
        name: /返回.*官网/,
      })).toHaveCount(0);
    }
  });
}
