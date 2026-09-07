import { test, expect, type Browser, type Page } from '@playwright/test';
import { readState } from '../scripts/env.mjs';

/**
 * E2E 培训链路（聆听者培训体系，database-design 培训体系 / trainings.pb.js 端点契约）：
 *   管理端培训列表 → 详情开放签到 → 参与者扫码落地页自助签到（重复扫码幂等）
 *   → 培训页「已通过」+ 账号级「已完成聆听者培训」标记 → 管理端名单 → 撤销 → 恢复「未参加」；
 *   负向：无 approved 聆听者报名的参与者扫码显示引导文案（listener_not_approved），培训页空态。
 * fixture 由 globalSetup 注入（见 scripts/seed.mjs）：published 培训（签到未开放）、
 * 第二活动上 approved 的聆听者/倾诉者报名各一个。移动端 viewport 360×740，与主链路一致。
 */

const state = readState();
const { webUrl, fixture } = state;
const VIEWPORT = { width: 360, height: 740 };

/** 以独立浏览器上下文打开管理端页面（三类会话 storage key 隔离，双角色互不干扰）。 */
async function newAdminPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.goto(`${webUrl}/admin/login`);
  await page.getByLabel('用户名').fill(fixture.adminUsername);
  await page.getByLabel('密码').fill(fixture.adminPassword);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL('**/admin/activities');
  return page;
}

/** 参与者经通用登录页登录（FR-AUTH-008；T2 手机验证码为备选登录方式），登录后落「我的」中心。 */
async function participantLogin(page: Page, phone: string) {
  await page.goto(`${webUrl}/login`);
  await page.getByRole('button', { name: '手机验证码登录' }).click();
  await page.getByRole('textbox', { name: /^手机号/ }).fill(phone);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '获取验证码' }).click();
  await page.getByRole('textbox', { name: /^验证码/ }).fill(fixture.phoneCode);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL('**/me');
}

test.describe.serial('培训链路', () => {
  test('开放签到→自助签到（幂等）→培训页已通过→名单→撤销→恢复未参加', async ({ page, browser }) => {
    // ---------- 1. 管理端培训列表可见已发布培训 ----------
    const adminPage = await newAdminPage(browser);
    await test.step('管理端培训列表', async () => {
      await adminPage.goto(`${webUrl}/admin/trainings`);
      const row = adminPage.locator('.admin-table tbody tr', { hasText: fixture.trainingTitle });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('已发布');
      await row.getByRole('link', { name: '管理' }).click();
      await adminPage.waitForURL(`**/admin/trainings/${fixture.trainingId}`);
    });

    // ---------- 1.5 管理端经 UI 创建培训（回归：创建载荷须显式带 draft，守卫才会放行） ----------
    await test.step('管理端创建培训', async () => {
      await adminPage.goto(`${webUrl}/admin/trainings`);
      await adminPage.getByRole('button', { name: '创建培训' }).click();
      const dialog = adminPage.getByRole('dialog', { name: '创建培训' });
      await dialog.getByLabel('培训标题').fill('E2E 临时培训');
      await dialog.getByLabel('培训代码').fill(`TR_E2E_TMP_${Date.now()}`);
      await dialog.getByLabel('开始时间').fill('2026-09-01T10:00');
      await dialog.getByLabel('结束时间').fill('2026-09-01T12:00');
      await dialog.getByRole('button', { name: '创建培训' }).click();
      await expect(dialog).toBeHidden();
      const row = adminPage.locator('.admin-table tbody tr', { hasText: 'E2E 临时培训' });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('草稿');
      // 回到种子培训详情页，后续步骤在该页操作
      await adminPage.goto(`${webUrl}/admin/trainings/${fixture.trainingId}`);
    });

    // ---------- 2. 详情页开放签到（FR-CHK-001 培训镜像） ----------
    await test.step('管理员开放培训签到', async () => {
      await adminPage.getByRole('button', { name: '开放签到' }).click();
      await expect(adminPage.getByText('已开放', { exact: true })).toBeVisible();
      await expect(adminPage.getByText('已签到 0 人')).toBeVisible();
    });

    // ---------- 3. 参与者登录 → 扫码落地页自助签到；重复扫码幂等（AC-20 培训镜像） ----------
    await test.step('参与者自助签到（重复扫码幂等）', async () => {
      await participantLogin(page, fixture.listenerPhone);
      await page.goto(`${webUrl}/training-checkin/${fixture.trainingCheckinToken}`);
      await expect(page.getByText('签到成功')).toBeVisible();
      await page.goto(`${webUrl}/training-checkin/${fixture.trainingCheckinToken}`);
      await expect(page.getByText('您已签到')).toBeVisible();
    });

    // ---------- 4. 培训页：该培训「已通过」+ 账号级「已完成聆听者培训」标记 ----------
    await test.step('参与者培训页显示已通过', async () => {
      await page.goto(`${webUrl}/trainings`);
      await expect(page.getByText('已完成聆听者培训')).toBeVisible();
      const item = page.locator('li.cc-item', { hasText: fixture.trainingTitle });
      await expect(item).toHaveCount(1);
      await expect(item.getByText(/已通过（签到于/)).toBeVisible();
    });

    // ---------- 5. 管理端签到名单出现该参与者（自助扫码 / 已签到） ----------
    await test.step('管理端签到名单', async () => {
      await adminPage.getByRole('button', { name: '刷新名单' }).click();
      await expect(adminPage.getByText('已签到 1 人')).toBeVisible();
      const row = adminPage.locator('.admin-table tbody tr', { hasText: fixture.listenerUsername });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('自助扫码');
      await expect(row).toContainText('已签到');
    });

    // ---------- 6. 管理员撤销签到（原因必填 + 审计；只改状态不删行） ----------
    await test.step('管理员撤销签到', async () => {
      const row = adminPage.locator('.admin-table tbody tr', { hasText: fixture.listenerUsername });
      await row.getByRole('button', { name: '撤销' }).click();
      const dialog = adminPage.getByRole('dialog', { name: '撤销签到' });
      await dialog.getByLabel('撤销原因').fill('E2E 撤销流程验证');
      await dialog.getByRole('button', { name: '确认撤销' }).click();
      await expect(dialog).toBeHidden();
      await expect(adminPage.getByText('已签到 0 人')).toBeVisible();
      await expect(row).toContainText('已撤销');
    });

    // ---------- 7. 参与者培训页恢复「未参加」，账号级培训通过标记消失 ----------
    await test.step('撤销后参与者培训页恢复未参加', async () => {
      await page.goto(`${webUrl}/trainings`);
      await expect(page.getByText('已完成聆听者培训')).toHaveCount(0);
      const item = page.locator('li.cc-item', { hasText: fixture.trainingTitle });
      await expect(item.getByText('未参加')).toBeVisible();
    });
  });

  test('无聆听者资格的参与者：扫码引导文案 + 培训页空态（listener_not_approved）', async ({ page }) => {
    // outsider 仅有 approved 倾诉者报名（倾诉者资格不视为聆听者资格）
    await participantLogin(page, fixture.outsiderPhone);

    await test.step('扫码落地页显示引导文案', async () => {
      await page.goto(`${webUrl}/training-checkin/${fixture.trainingCheckinToken}`);
      await expect(page.getByText('暂未开放培训签到')).toBeVisible();
      await expect(page.getByText(/需要先报名聆听者并通过审核后才能参加培训签到/)).toBeVisible();
    });

    await test.step('培训页空态引导', async () => {
      await page.goto(`${webUrl}/trainings`);
      await expect(page.getByText('培训功能暂未开放')).toBeVisible();
      await expect(page.getByText(/报名聆听者并通过审核后开放培训功能/)).toBeVisible();
      // 空态不泄露任何培训信息
      await expect(page.getByText(fixture.trainingTitle)).toHaveCount(0);
    });
  });
});
