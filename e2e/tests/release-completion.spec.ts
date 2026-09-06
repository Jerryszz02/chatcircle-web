import { test, expect } from "@playwright/test";
import { readState } from "../scripts/env.mjs";
const { webUrl, fixture } = readState();

test("创建向导保存现场和问卷计划，机构模板复用不直接发布", async ({ page }) => {
  await page.goto(`${webUrl}/admin/login`);
  await page.getByLabel("用户名或邮箱").fill(fixture.adminUsername);
  await page.getByLabel("密码").fill(fixture.adminPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/admin/activities");
  await page.goto(`${webUrl}/admin/activities/new`);
  await page.getByLabel("活动标题").fill("上线向导验收");
  await page.getByLabel("活动代码").fill("CC_E2E_RELEASE");
  await page.getByLabel(/^开始时间/).fill("2027-09-01T10:00");
  await page.getByLabel(/^结束时间/).fill("2027-09-01T12:00");
  await page.getByLabel("总名额").fill("20");
  await page.getByRole("button", { name: "下一步" }).click();
  const nameRow = page.locator(".admin-field-row").filter({ hasText: "姓名" });
  await expect(nameRow.getByRole("checkbox", { name: "启用" })).toBeChecked();
  await expect(nameRow.getByRole("checkbox", { name: "必填" })).toBeDisabled();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByLabel("预计签到开放时间").fill("2027-09-01T09:30");
  await page.getByLabel("启用现场配对").uncheck();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("checkbox").first().check();
  await page.getByLabel(/问卷阶段/).selectOption("after");
  await page.getByLabel(/预计开放时间/).fill("2027-09-01T12:00");
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByText(/现场配对：关闭/)).toBeVisible();
  await page.getByRole("button", { name: "创建草稿" }).click();
  await expect(page.getByRole("heading", { name: "活动已创建" })).toBeVisible();
  await expect(page.getByText(/已创建（草稿）/)).toBeVisible();
  await page.getByRole("link", { name: "进入活动详情" }).click();
  await page.getByRole("tab", { name: "活动设置" }).click();
  await expect(page.getByLabel(/启用现场配对/)).not.toBeChecked();
  await expect(page.getByLabel("预计签到开放时间")).toHaveValue("2027-09-01T09:30");
  await page.getByRole("tab", { name: "问卷管理" }).click();
  await expect(page.getByText(/阶段：活动后/)).toBeVisible();
  await page.goto(`${webUrl}/admin/activities`);
  await page
    .locator("tr")
    .filter({ hasText: "CC_E2E_RELEASE" })
    .getByRole("button", { name: "另存为机构模板" })
    .click();
  await expect(page.getByText(/这是机构模板/)).toBeVisible();
  await expect(page.getByRole("button", { name: "发布", exact: true })).toHaveCount(0);
  await page.goto(`${webUrl}/admin/activities/new`);
  await page.getByRole("button", { name: /上线向导验收/ }).click();
  await expect(page.getByRole("heading", { name: /上线向导验收/ })).toBeVisible();
  await expect(page.getByText(/这是机构模板/)).toHaveCount(0);
  await page.getByRole("tab", { name: "活动设置" }).click();
  await expect(page.getByLabel("预计签到开放时间")).toHaveValue("");
  await expect(page.getByLabel(/启用现场配对/)).not.toBeChecked();
});

test("360px 隐私全文、备案和管理员邮件入口可访问", async ({ page }) => {
  await page.goto(`${webUrl}/privacy`);
  await expect(page.getByRole("heading", { name: "Chat Circles 隐私政策" })).toBeVisible();
  await expect(page.getByText("沪ICP备2026002363号-2")).toHaveAttribute("href", "https://beian.miit.gov.cn/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto(`${webUrl}/admin/login`);
  await page.getByRole("link", { name: "邮箱验证码登录" }).click();
  await expect(page.getByRole("heading", { name: "邮箱验证码登录" })).toBeVisible();
  await expect(page.getByLabel("注册邮箱")).toBeVisible();
});
