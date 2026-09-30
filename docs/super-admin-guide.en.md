# Super Administrator Tutorial

[中文](super-admin-guide.md) | English

> **Who this document is for:** The operations lead at the Chat Circles platform operator, Empact. No technical knowledge is required. Use the page buttons to onboard organizations, approve activities, publish content, and view data across the platform.
>
> **Are you a staff member at an organization?** See the other tutorial: [Organization Administrator Tutorial](org-admin-guide.en.md).

UI labels below are translated into English and followed by the Chinese labels shown in the current interface. Linked specialist documentation may be in Chinese.

---

## 0. Get to know the administration area in 30 seconds

- Sign-in address: **`chatcircle.empact.cn/super/login`** (`/super` alone does not open the page, so include `/login`).
- Super administrator accounts **have no self-service registration page**; they are created during deployment. Sign in with an email address and password.
- A super administrator can see data from **all organizations across the platform**. Take particular care to keep it confidential.
- Another address you may have seen, `/_/`, is the database's underlying administration interface. **It is not needed for everyday operations** and is blocked in production. Technical staff may temporarily use it for troubleshooting. This tutorial does not cover it.

## 1. What the administration area looks like

After sign-in, the left menu has eight items:

| Menu | Purpose |
|---|---|
| **Organizations and invitations (机构与邀请码)** | The most frequently used area: onboard new organizations, issue administrator invitation codes, adjust organization settings, and disable organizations. |
| **Publication approvals (发布审批)** | Approve activity publication requests submitted by organizations. |
| **Activity oversight (活动监管)** | View all activities across the platform and take them down if necessary. |
| **Content posts (内容推文)** | Publish posts/articles shown on the public website's homepage. |
| **Global dashboard (全局看板)** | View statistics across the platform. |
| **Global exports (全局导出)** | Export data for the entire platform or selected organizations. |
| **Global audit (全局审计)** | Search operation records across the platform. |
| **System and templates (系统与模板)** | Check daily backup status and maintain standard survey templates. |

After using a shared computer, click **Sign out (退出登录)** at the bottom left.

## 2. The most common task: onboard a new organization

The full workflow has just four steps:

1. **Create the organization:** Go to **Organizations and invitations (机构与邀请码)** → **Create organization (创建机构)**. Enter the organization's name and, optionally, a note (visible only within the platform's administration area).
   - New organizations default to **direct activity publication** (without your approval) and **no permission for sensitive exports**. To change these settings, see the next step.
2. **Configure settings** (optional): In the organization's row, click **Configure settings (配置开关)**:
   - **Activity publication requires platform review (活动发布需平台审核):** When enabled, each activity published by this organization is visible publicly only after you approve it under **Publication approvals (发布审批)**.
   - **Allow sensitive exports by organization administrators (允许机构管理员敏感导出):** When enabled, the organization's administrators can include sensitive fields such as names and phone numbers in data exports. **This is a high-risk action. Before enabling it, confirm that the organization has a specific purpose and an accountable person.** See the [privacy operations manual](privacy-operations.md).
   - Note: Selecting a setting **does not apply it immediately**. A dialog explains the consequences, and you must click **Confirm change (确认变更)**. This deliberately prevents accidental changes.
3. **Issue an invitation code:** In the organization's row, click **Generate invitation code (生成邀请码)**, set its validity period (7 days by default, up to 90 days), then click **Generate (生成)**.
   - ⚠️ **The invitation code is shown in plain text only once!** As soon as the dialog appears, click **Copy invitation code (复制邀请码)** and send it to your organization contact through a secure channel, such as a private WeChat message or verbally by phone. After the dialog closes, even the platform cannot retrieve it; you can only generate a new one.
   - Invitation codes are **single-use**: each code can register only one administrator account. Generate another code if the organization needs a second administrator.
   - The **Administrator invitation codes (管理员邀请码)** list below shows each code's status: **Unused / Used / Revoked / Expired (未使用 / 已使用 / 已撤销 / 已过期)**. Click **Revoke (撤销)** for a code that is no longer needed.
4. **Hand it over:** The organization contact uses the invitation code to register at `chatcircle.empact.cn/admin/register`. Refer them to the [Organization Administrator Tutorial](org-admin-guide.en.md) for subsequent work.

## 3. Approve activity publication requests

This step applies only to organizations with **Publication requires platform review (发布需平台审核)** enabled.

1. The **Publication approvals (发布审批)** page lists all activities pending review, including title, organization, time, capacity, and submission time.
2. Click **Approve (批准)** → confirm. The activity becomes public immediately: it appears in the website's **Activity directory (活动广场)** and can be opened directly through its link or QR code.
3. Click **Reject (驳回)** → **enter a rejection reason; this is required**. The organization can see it, make changes, and resubmit.

Both approvals and rejections are recorded in the approval history and audit logs and can be checked at any time.

## 4. Activity oversight and taking activities down

The **Activity oversight (活动监管)** page lets you filter and view all activities by organization and status.

- For **Published (已发布)** activities, the actions column contains **Take down (下架)**. After an activity is taken down, its public entry point **becomes inaccessible immediately**, while its historical registrations, check-ins, and other data remain intact and traceable.
- Taking down an activity is usually appropriate when its content violates requirements or the organization requests urgent removal. We recommend calling the organization before taking it down.

## 5. Publish content posts

Articles managed under **Content posts (内容推文)** appear on the public website (on the homepage, among past activities, and elsewhere). Article URLs use `/posts/xxxxx`.

1. Click **New post (新建推文)** and complete:
   - **Title (标题)** (required) and **Summary (摘要)** (optional).
   - **Cover image (封面图):** One image, no larger than 5MB; jpg/png/webp/gif are supported.
   - **Body (正文):** Markdown (simple notation such as `#` for headings, `**bold**`, and lists).
   - **External URL (外链 URL)** (optional): Provide at least a body or an external link.
   - **Visibility (可见性):** **Visible (可见)** displays it publicly immediately; **Hidden (隐藏)** makes it visible only in the administration area.
2. Row actions let you **Edit (编辑)**, **Pin / Unpin (置顶 / 取消置顶)**, and **Hide / Make visible (隐藏 / 设为可见)** at any time.

> ⚠️ Posts **have no delete button**. Use **Hide (隐藏)** to remove a post from public view. The action is retained in the audit log.

## 6. Global dashboard and exports

### 6.1 Global dashboard

The **Global dashboard (全局看板)** can be filtered by date, organization, activity status, and role. Its metric definitions match the organization's dashboard (8 metrics, including activity count, registrations, participant visits, and survey completion rate). A **backup failure warning banner** at the top means yesterday's automatic backup failed. Notify technical staff (see section 7 for the backup mechanism).

### 6.2 Global exports

Go to **Global exports (全局导出)** → **New export (新建导出)**: select a scope (**entire platform / selected organization / single activity**) → click **Create export (创建导出)**.

- Selecting **Include personal information fields (sensitive export) (包含个人信息字段（敏感导出）)** opens a red second-confirmation dialog. The export runs only after you click **Confirm export of personal information (确认导出个人信息)**. **Every sensitive export is recorded in the audit log**; use it only when needed.
- Click **Download (下载)** in the **Export history (导出记录)** table below to obtain the file. Each record includes a file checksum that can be used to confirm that the file has not been modified.
- Super administrator exports are not limited by the organization's sensitive-export setting, so use particular care. Exported files contain participants' personal information: use them only as needed for work, store them securely, and clear them promptly. See the [privacy operations manual](privacy-operations.md) for compliance requirements.

## 7. System and templates

### 7.1 Backup status (read-only)

The top of **System and templates (系统与模板)** shows the time and result of the latest automatic backup. The database and uploaded files are **backed up automatically every day, with the latest 2 backups retained locally, including backups made before deployment**. No manual intervention is needed, and the page has no manual backup button. Notify technical staff if you see a failure warning.

### 7.2 Standard form templates

Four active templates are shown by default: the **Chatter registration form (Chatter 报名表)** for speakers, the **Listener registration form (Listener 报名表)**, and two post-activity surveys dated 2026-09-24. Select **Show disabled historical templates (显示已停用的历史模板)** to view older templates. Disabling a template does not delete historical surveys or submissions.

The two registration templates are maintained in sync with the platform's standard registration fields. You can preview and try them here. New activities display the registration fields for the selected role; dates, venues, meals, and training time slots are configured separately for each activity. Organizations can adjust whether fields are enabled and required in the activity's registration form configuration. Existing activities retain their registration-field settings during an upgrade.

Post-activity surveys are still generated using **Create survey from template (从模板创建问卷)**; registration templates do not appear in this selection list. Post-activity survey roles match their templates, and new post-activity surveys use the **After the activity (活动后)** phase. The Chatter post-activity survey retains 23 main questions and provides a supplementary input when **Other (其他)** is selected in question 21. The Listener post-activity survey has 19 questions. Each person's submission is linked to their registration by the system; Listener question 10 asks for their partner's Chatter identifier (for example, C07).

The maintenance actions below apply to activity survey templates. Registration templates are released with standard-field versions.

- **New template (新建模板):** Enter a template code (starting with an uppercase letter and unique across the platform), name, and description; add questions with the visual editor → click **Create template (创建模板)**.
- **Publish new version (发布新版本):** To change questions, publish a new version of the existing template rather than creating another template. Once published, the new version cannot be edited and **affects only activity surveys created afterward**. Existing activity surveys remain fixed to the old version and are not changed.
- **Disable / Enable (停用 / 启用):** Disabled templates cannot be selected by organizations when creating activities. Existing surveys are unaffected.
- **Preview (预览)** and **Version list (版本列表)** show each version's questions and publication records.

## 8. Global audit

The **Global audit (全局审计)** page searches operation records across the platform by date, operator, organization, action keyword (such as `export` or `invite`), and result (**Success / Failure (成功 / 失败)**). Logs cannot be edited or deleted. They are useful for questions such as who created an organization or who performed a sensitive export.

## 9. Frequently asked questions (FAQ)

**Q: What if an organization loses its invitation code or I did not copy it?**
A: The plain-text code cannot be recovered (only its verification hash is stored). **Generate invitation code (生成邀请码)** again for that organization and revoke the old code.

**Q: An organization wants to change administrators. What should happen to the old account?**
A: Issue a new invitation code so the organization can register a new account. Each account currently exists independently; contact technical staff if the old account needs to be disabled.

**Q: Can I edit an organization's activities or review its registrations for it?**
A: The super administrator interface does not provide these actions. Organizations manage their own activities day to day; the platform handles oversight actions such as approval and taking activities down. This separation of responsibilities is deliberate.

**Q: An organization says it cannot export names.**
A: Under **Organizations and invitations (机构与邀请码)**, check whether **Allow sensitive exports (允许敏感导出)** is enabled for that organization. It is disabled by default. Enable it only after confirming a compliant purpose for using the data.

**Q: What happens if I disable an organization?**
A: All of its administrators **immediately lose the ability to sign in**, while activity data is retained. You can **Enable (启用)** the organization again at any time.

**Q: Can I change platform-standard participant registration fields here, such as adding a standard “School (学校)” field?**
A: The interface does not currently support this. Contact technical staff to make the change through the backend API.

## 10. Compliance boundaries (please remember)

1. Super administrator accounts have the broadest permissions: **do not lend them to others**, do not use weak passwords, and always sign out after using a shared computer.
2. Exported files containing names or phone numbers are the platform's most sensitive data. Export only as needed, restrict access to those who need it, and clear the files after use.
3. Register and process participants' access, correction, deletion, and account closure requests using the [privacy operations manual](privacy-operations.md). Do not resolve them by casually editing data in the administration area.
4. Share only public activity and survey links externally. Never share administration addresses or exported files.
