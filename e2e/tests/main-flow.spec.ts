import { test, expect, type Browser, type Page } from '@playwright/test';
import AdmZip from 'adm-zip';
import { readState } from '../scripts/env.mjs';

/**
 * E2E 主链路（test-plan §5，对应 PRD §1.3 端到端成功定义，360×740 移动端 viewport）：
 *   公开详情 → 自动注册 → 报名 → 管理员审核通过 → 开放签到 → 自助签到（重复扫码幂等）
 *   → 从模板创建并开放问卷 → 参与者提交问卷 → 我的中心查看 → 管理员导出 ZIP 并校验内容。
 * fixture 由 globalSetup 注入（见 scripts/seed.mjs），本文件只消费状态文件里的 id 与凭据。
 */

const state = readState();
const { webUrl, fixture } = state;
const VIEWPORT = { width: 360, height: 740 };

/** 导出 ZIP 应有的 13 个 CSV（PRD §10.1，与 exports.pb.js 注释一致）。 */
const EXPECTED_CSVS = [
  'organizations.csv', 'activities.csv', 'participants.csv', 'registrations.csv',
  'registration_answers.csv', 'checkins.csv', 'survey_templates.csv', 'surveys.csv',
  'submissions.csv', 'answers.csv', 'custom_fields.csv', 'data_dictionary.csv', 'manifest.csv',
];

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

test.describe.serial('V1 主链路', () => {
  test('详情→注册→报名→审核→签到→问卷→我的中心→导出', async ({ page, browser }) => {
    const A = fixture.answers;

    // ---------- 1. 公开详情（未登录可见，AC-05） ----------
    await test.step('公开活动详情未登录可见', async () => {
      await page.goto(`${webUrl}/a/${fixture.activityId}`);
      await expect(page.getByRole('heading', { name: fixture.activityTitle })).toBeVisible();
      await expect(page.getByRole('link', { name: '立即报名' })).toBeVisible();
    });

    // ---------- 2. 点击报名 → 单框自动注册并登录（AC-06） ----------
    await test.step('报名链路自动注册', async () => {
      await page.getByRole('link', { name: '立即报名' }).click();
      await page.waitForURL(`**/a/${fixture.activityId}/register`);
      await page.getByLabel('用户名').fill(fixture.participantUsername);
      await page.getByLabel('密码').fill(fixture.participantPassword);
      await page.getByRole('button', { name: '继续' }).click();
      // 注册成功后出现报名表
      await expect(page.getByRole('button', { name: '提交报名' })).toBeVisible();
    });

    // ---------- 3. 选择角色、填写报名表、提交（FR-REG-001/002） ----------
    await test.step('提交报名表', async () => {
      await page.getByRole('radio', { name: /倾诉者/ }).check();
      await page.getByLabel('昵称').fill(A.nickname);
      await page.getByLabel('年龄').fill(A.age);
      await page.getByLabel('微信号').fill(A.wechat);
      await page.getByRole('button', { name: '提交报名' }).click();
      // 提交成功页：状态 + 保存凭据回访指引（FR-PAR-003）
      await expect(page.getByRole('heading', { name: '报名已提交' })).toBeVisible();
      await expect(page.getByText('请保存好您的凭据')).toBeVisible();
      await expect(page.getByText('待审核').first()).toBeVisible();
    });

    // ---------- 4. 管理员后台审核通过（AC-07） ----------
    const adminPage = await newAdminPage(browser);
    await test.step('管理员审核通过报名', async () => {
      await adminPage.goto(`${webUrl}/admin/activities/${fixture.activityId}`);
      // 默认「报名审核 → 待审核」
      await adminPage.getByRole('button', { name: '通过', exact: true }).click();
      const dialog = adminPage.getByRole('dialog', { name: '审核通过' });
      await dialog.getByRole('button', { name: '确认' }).click();
      await expect(dialog).toBeHidden();
      // 「已通过」页签出现 1 条记录
      await adminPage.getByRole('tab', { name: '已通过' }).click();
      await expect(adminPage.locator('.admin-table tbody tr')).toHaveCount(1);
    });

    // ---------- 5. 管理员开放签到（FR-CHK-001） ----------
    await test.step('管理员开放签到', async () => {
      await adminPage.getByRole('tab', { name: '签到管理' }).click();
      await adminPage.getByRole('button', { name: '开放签到' }).click();
      await expect(adminPage.getByText('已开放')).toBeVisible();
    });

    // ---------- 6. 参与者自助签到；重复扫码幂等提示已签到（AC-09/AC-20） ----------
    await test.step('参与者自助签到（重复扫码幂等）', async () => {
      await page.goto(`${webUrl}/checkin/${fixture.activityId}`);
      await expect(page.getByText('签到成功')).toBeVisible();
      await page.goto(`${webUrl}/checkin/${fixture.activityId}`);
      await expect(page.getByText('您已签到')).toBeVisible();
    });

    // ---------- 7. 管理员从模板创建问卷并开放（FR-SUR-001/011） ----------
    await test.step('管理员创建并开放问卷', async () => {
      await adminPage.getByRole('tab', { name: '问卷管理' }).click();
      await adminPage.getByRole('button', { name: '从模板创建问卷' }).click();
      const dialog = adminPage.getByRole('dialog', { name: '从模板创建问卷' });
      // 第一个占位选项之后即唯一模板
      await dialog.locator('#survey-template').selectOption({ index: 1 });
      await dialog.getByLabel('问卷标题').fill(fixture.surveyTitle);
      await dialog.getByRole('button', { name: '创建' }).click();
      await expect(dialog).toBeHidden();
      const card = adminPage.locator('section.cc-card', { hasText: fixture.surveyTitle }).first();
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: '开放填写' }).click();
      await expect(adminPage.getByText('开放中').first()).toBeVisible();
    });

    // ---------- 8. 参与者从「我的」中心进入并正式提交问卷（FR-SUR-006~009） ----------
    await test.step('参与者提交问卷', async () => {
      await page.goto(`${webUrl}/me`);
      await page.getByRole('link', { name: '去填写' }).click();
      await page.waitForURL('**/survey/**');
      // MOOD(scale_1_5, 敏感) 选 4；SAT 选「满意」；NOTE 填文本
      await page.getByRole('group', { name: '最近一周情绪状态' })
        .getByRole('radio', { name: '4', exact: true }).check();
      await page.getByRole('group', { name: '整体满意度' })
        .getByRole('radio', { name: A.satLabel }).check();
      await page.getByLabel('想说的话').fill(A.note);
      await page.getByRole('button', { name: '正式提交' }).click();
      const dialog = page.getByRole('dialog', { name: '确认提交' });
      await dialog.getByRole('button', { name: '确认提交' }).click();
      // 提交后进入本人答案只读视图（FR-SUR-009）
      await expect(page.getByRole('heading', { name: '我的答卷（只读）' })).toBeVisible();
      await expect(page.getByText(A.note)).toBeVisible();
    });

    // ---------- 9. 「我的」中心可见已提交答卷（AC-22） ----------
    await test.step('我的中心查看已提交答卷', async () => {
      await page.goto(`${webUrl}/me`);
      const submittedCard = page.locator('section.cc-card', {
        has: page.getByRole('heading', { name: '已提交的答卷' }),
      });
      await expect(submittedCard.getByText(fixture.surveyTitle)).toBeVisible();
      await expect(submittedCard.getByRole('link', { name: '查看答案（只读）' })).toBeVisible();
      // 我的报名状态为已通过
      await expect(page.getByText('已通过').first()).toBeVisible();
    });

    // ---------- 10. 管理员普通导出并下载 ZIP；校验内容（AC-16） ----------
    await test.step('管理员导出 ZIP 并校验内容', async () => {
      await adminPage.goto(`${webUrl}/admin/exports`);
      await adminPage.getByRole('button', { name: '创建导出任务' }).click();
      await expect(adminPage.getByText('已完成').first()).toBeVisible();

      const downloadPromise = adminPage.waitForEvent('download');
      await adminPage.getByRole('button', { name: '下载 ZIP' }).first().click();
      const download = await downloadPromise;
      const zipPath = await download.path();
      expect(zipPath).toBeTruthy();

      const zip = new AdmZip(zipPath!);
      const csvOf = (name: string) => zip.readAsText(name);
      const names = zip.getEntries().map((e) => e.entryName).sort();
      expect(names).toEqual([...EXPECTED_CSVS].sort());
      // CSV 规范：UTF-8 BOM（PRD §10.3）
      expect(csvOf('registrations.csv').startsWith('﻿')).toBe(true);

      // 包含本次链路的报名 / 签到 / 答卷记录
      expect(csvOf('registrations.csv')).toContain(fixture.activityId);
      expect(csvOf('registrations.csv')).toContain('approved');
      expect(csvOf('checkins.csv')).toContain('valid');
      expect(csvOf('submissions.csv')).toContain('submitted');
      expect(csvOf('answers.csv')).toContain('SAT');
      expect(csvOf('answers.csv')).toContain(A.sat);
      expect(csvOf('answers.csv')).toContain(A.note);
      expect(csvOf('registration_answers.csv')).toContain(A.nickname);

      // 敏感过滤（FR-EXP-002）：敏感题 MOOD、敏感报名字段与普通导出用户名均不出现
      expect(csvOf('answers.csv')).not.toContain('MOOD');
      expect(csvOf('registration_answers.csv')).not.toContain('wechat_id');
      expect(csvOf('registration_answers.csv')).not.toContain(A.wechat);
      expect(csvOf('participants.csv')).not.toContain(fixture.participantUsername);
      expect(csvOf('participants.csv').split('\r\n')[0]).not.toContain('username');
    });
  });
});
