import { test, expect } from '@playwright/test';
import { readState } from '../scripts/env.mjs';

const { webUrl } = readState();

for (const width of [1440, 390]) {
  test(`公开页脚在 ${width}px 下链接清晰可读且无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/', '/about']) {
      await page.goto(`${webUrl}${path}`);
      const footer = page.getByRole('contentinfo');
      await footer.scrollIntoViewIfNeeded();
      await expect(footer).toHaveCSS('background-color', 'rgb(18, 82, 132)');
      for (const link of await footer.getByRole('link').all()) {
        await expect(link).toHaveCSS('color', 'rgb(255, 255, 255)');
      }
      await footer.locator('img').evaluateAll(images =>
        Promise.all(images.map(image => (image as HTMLImageElement).decode())),
      );
      expect(await footer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const privacy = footer.getByRole('link', { name: '隐私政策' });
      await privacy.focus();
      await expect(privacy).toBeFocused();
      await expect(privacy).toHaveCSS('outline-style', 'solid');
    }
  });
}
