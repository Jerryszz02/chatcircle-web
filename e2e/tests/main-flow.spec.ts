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

/** 导出 ZIP 应有的 v2 CSV（细粒度导出；registrations.csv 等系统/报名字段已拆为列）。 */
const EXPECTED_CSVS = [
  'registrations.csv', 'checkins.csv', 'pairings.csv', 'data_dictionary.csv', 'manifest.csv',
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

/** 参与者经手机号验证码登录，用于同场活动双角色独立会话。 */
async function participantLogin(page: Page, phone: string) {
  await page.goto(`${webUrl}/login`);
  await page.getByRole('textbox', { name: /^手机号/ }).fill(phone);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '获取验证码' }).click();
  await page.getByRole('textbox', { name: /^验证码/ }).fill(fixture.phoneCode);
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  await page.waitForURL('**/me');
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

    // ---------- 2. 点击报名 → 手机号验证码登录（T1） ----------
    await test.step('报名链路手机号登录', async () => {
      await page.getByRole('link', { name: '立即报名' }).click();
      await page.waitForURL(`**/a/${fixture.activityId}/register`);
      await page.getByRole('textbox', { name: /^手机号/ }).fill(fixture.participantPhone);
      await expect(page.getByText(/我们仅将你的姓名和手机号用于账号验证/)).toBeVisible();
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: '获取验证码' }).click();
      await page.getByRole('textbox', { name: /^验证码/ }).fill(fixture.phoneCode);
      await page.getByRole('button', { name: '登录 / 注册' }).click();
      await expect(page.getByRole('button', { name: '提交报名' })).toBeVisible();
    });

    // ---------- 3. 选择角色、填写报名表、提交（FR-REG-001/002） ----------
    await test.step('提交报名表', async () => {
      await page.getByRole('radio', { name: /倾诉者/ }).check();
      await page.getByLabel('昵称').fill(A.nickname);
      await page.getByLabel('姓名').fill(A.fullName);
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
      // 「已通过」包含本次倾诉者与 T7 fixture 中的聆听者。
      await adminPage.getByRole('tab', { name: '已通过' }).click();
      await expect(adminPage.locator('.admin-table tbody tr')).toHaveCount(2);
    });

    // ---------- 5. 管理员开放签到（FR-CHK-001） ----------
    await test.step('管理员开放签到', async () => {
      await adminPage.getByRole('tab', { name: '签到管理' }).click();
      await adminPage.getByRole('button', { name: '开放签到' }).click();
      await expect(adminPage.getByText('已开放')).toBeVisible();
    });

    // ---------- 6. 双角色自助签到；现场编号与重复扫码幂等（T2/AC-09/AC-20） ----------
    const listenerContext = await browser.newContext({ viewport: VIEWPORT });
    const listenerPage = await listenerContext.newPage();
    await test.step('聆听者独立会话签到并获取 L01', async () => {
      await participantLogin(listenerPage, fixture.listenerPhone);
      await listenerPage.goto(`${webUrl}/checkin/${fixture.checkinQrToken}`);
      await expect(listenerPage.getByText('签到成功')).toBeVisible();
      await expect(listenerPage.getByText('L01', { exact: true })).toBeVisible();
      await expect(listenerPage.getByText('等待开始配对')).toBeVisible();
    });

    await test.step('倾诉者自助签到（重复扫码幂等）并获取 S01', async () => {
      await page.goto(`${webUrl}/checkin/${fixture.checkinQrToken}`);
      await expect(page.getByText('签到成功')).toBeVisible();
      await expect(page.getByText('S01', { exact: true })).toBeVisible();
      await expect(page.getByText('等待开始配对')).toBeVisible();
      await page.goto(`${webUrl}/checkin/${fixture.checkinQrToken}`);
      await expect(page.getByText('您已签到')).toBeVisible();
    });

    // ---------- 6.5 管理员在实时工作台启动配对；两端通过 Realtime 失效重拉收到结果 ----------
    await test.step('现场工作台开始配对并实时刷新两端卡片', async () => {
      await adminPage.getByRole('tab', { name: '现场工作台' }).click();
      const pairingCard = adminPage.locator('section.cc-card', {
        has: adminPage.getByRole('heading', { name: '配对', exact: true }),
      });
      await expect(pairingCard.getByText(/已签到：倾诉者\s*1\s*·\s*聆听者\s*1/)).toBeVisible();
      await pairingCard.getByRole('button', { name: '开始配对', exact: true }).click();
      await expect(adminPage.getByText('配对已开始，新建 1 组')).toBeVisible();

      await expect(page.getByText('已配对', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '查看组号与搭档' }).click();
      await expect(page.getByText('P01', { exact: true })).toBeVisible();
      await expect(page.getByText('L01', { exact: true })).toBeVisible();
      await expect(page.getByText(fixture.listenerFullName, { exact: true })).toBeVisible();

      await expect(listenerPage.getByText('已配对', { exact: true })).toBeVisible();
      await listenerPage.getByRole('button', { name: '查看组号与搭档' }).click();
      await expect(listenerPage.getByText('P01', { exact: true })).toBeVisible();
      await expect(listenerPage.getByText('S01', { exact: true })).toBeVisible();
      await expect(listenerPage.getByText(A.fullName, { exact: true })).toBeVisible();
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

    // ---------- 10. 管理员细粒度导出：五步向导 → 生成 CSV ZIP 并校验内容（AC-16） ----------
    await test.step('管理员经向导导出 CSV ZIP 并校验内容', async () => {
      await adminPage.goto(`${webUrl}/admin/exports`);
      // 第 1 步（范围）：默认机构全部 → 下一步
      await adminPage.getByRole('button', { name: '下一步' }).click();
      // 第 2 步（数据域）：元数据加载期间预设按钮 disabled，待其 enabled 即代表元数据就绪
      const fullPreset = adminPage.getByRole('button', { name: '活动完整复盘' });
      await expect(fullPreset).toBeEnabled();
      await fullPreset.click();
      await adminPage.getByRole('button', { name: '下一步' }).click();
      // 第 3 步（行筛选）：默认 → 下一步
      await adminPage.getByRole('button', { name: '下一步' }).click();
      // 第 4 步（字段）：预设已填 → 下一步
      await adminPage.getByRole('button', { name: '下一步' }).click();
      // 第 5 步（格式）：切到 CSV ZIP → 生成预览 → 创建
      await adminPage.getByRole('radio', { name: /规范化 CSV ZIP/ }).check();
      await adminPage.getByRole('button', { name: '生成预览' }).click();
      await expect(adminPage.getByRole('button', { name: '创建导出任务' })).toBeEnabled();
      await adminPage.getByRole('button', { name: '创建导出任务' }).click();
      await expect(adminPage.getByText('已完成').first()).toBeVisible();

      const downloadPromise = adminPage.waitForEvent('download');
      await adminPage.getByRole('button', { name: '下载' }).first().click();
      const download = await downloadPromise;
      const zipPath = await download.path();
      expect(zipPath).toBeTruthy();

      const zip = new AdmZip(zipPath!);
      const csvOf = (name: string) => zip.readAsText(name);
      const names = zip.getEntries().map((e) => e.entryName).sort();
      const surveyCsv = names.find((n) => n.startsWith('survey_'));
      expect(surveyCsv).toBeTruthy();
      expect(names).toEqual([...EXPECTED_CSVS, surveyCsv!].sort());
      // CSV 规范：UTF-8 BOM（PRD §10.3）
      expect(csvOf('registrations.csv').startsWith('﻿')).toBe(true);

      // 包含本次链路的报名 / 签到 / 答卷记录（v2 已把报名字段拆为 registrations 列）
      expect(csvOf('registrations.csv')).toContain(fixture.activityId);
      expect(csvOf('registrations.csv')).toContain('approved');
      expect(csvOf('registrations.csv')).toContain(A.nickname);
      expect(csvOf('checkins.csv')).toContain('valid');
      expect(csvOf('pairings.csv')).toContain('P01');
      expect(csvOf('pairings.csv')).toContain('S01');
      expect(csvOf('pairings.csv')).toContain('L01');
      expect(csvOf(surveyCsv!)).toContain('submitted');
      expect(csvOf(surveyCsv!)).toContain('SAT');
      expect(csvOf(surveyCsv!)).toContain(A.sat);
      expect(csvOf(surveyCsv!)).toContain(A.note);

      // 敏感过滤（FR-EXP-002）：敏感题 MOOD、敏感报名字段与普通导出用户名均不出现
      expect(csvOf(surveyCsv!)).not.toContain('MOOD');
      expect(csvOf('registrations.csv')).not.toContain('wechat_id');
      expect(csvOf('registrations.csv')).not.toContain(A.wechat);
      expect(csvOf('registrations.csv')).not.toContain(A.fullName);
      expect(csvOf('registrations.csv')).not.toContain(fixture.participantUsername);
      expect(csvOf('manifest.csv')).toContain('csv_zip');
    });

    await listenerContext.close();
  });
});
