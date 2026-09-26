import { test, expect } from '@playwright/test';
import { readState } from '../scripts/env.mjs';

const { webUrl, fixture } = readState();

for (const width of [1440, 390, 320]) {
  test(`公开页脚在 ${width}px 下链接清晰可读且无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      '/', '/about', '/activities', '/activities/past', '/privacy', '/posts/missing', '/login',
      `/a/${fixture.activityId}`, `/a/${fixture.activityId}/register`,
    ]) {
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

for (const width of [1440, 390, 320]) {
  test(`参与者流程在 ${width}px 下沿用首页导航和页脚`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${webUrl}/login`);
    const main = page.getByRole('main');
    await main.getByRole('textbox', { name: /^用户名或手机号/ }).fill(fixture.participantUsername);
    await main.getByRole('textbox', { name: /^密码$/ }).fill(fixture.participantPassword);
    await main.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/me');
    for (const path of [
      '/me', '/trainings', `/a/${fixture.activityId}/register`,
      `/checkin/${fixture.checkinQrToken}`, `/training-checkin/${fixture.trainingCheckinToken}`,
      '/survey/missing',
    ]) {
      await page.goto(`${webUrl}${path}`);
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page.locator('.ccp-site')).toHaveCSS('background-color', 'rgb(243, 240, 231)');
      await expect(page.getByRole('banner')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      await expect(page.getByRole('navigation', { name: '站点导航' })).toBeVisible();
      await expect(page.getByRole('banner').getByRole('link', { name: '我的中心' })).toBeVisible();
      const footer = page.getByRole('contentinfo');
      await footer.scrollIntoViewIfNeeded();
      await expect(footer).toHaveCSS('background-color', 'rgb(18, 82, 132)');
      for (const link of await footer.getByRole('link').all()) {
        await expect(link).toHaveCSS('color', 'rgb(255, 255, 255)');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.getByRole('main').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const privacy = footer.getByRole('link', { name: '隐私政策' });
      await privacy.focus();
      await expect(privacy).toHaveCSS('outline-style', 'solid');
    }
  });
}
