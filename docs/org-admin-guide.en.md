# Organization Administrator Tutorial

[中文](org-admin-guide.md) | English

> **Who this document is for:** Staff at partner organizations. You do not need technical knowledge. If you can find the buttons on the page, you can handle the entire workflow from publishing an activity to exporting its data.
>
> **Are you a super administrator (the platform operator)?** See the other tutorial: [Super Administrator Tutorial](super-admin-guide.en.md).

UI labels below are translated into English and followed by the Chinese labels shown in the current interface. Linked specialist documentation may be in Chinese.

---

## 0. Get to know the administration area in 30 seconds

- Sign-in address: **`chatcircle.empact.cn/admin/login`** (enter it in your browser's address bar; `/admin` alone does not open the page, so include `/login`).
- You can see activities, registrations, surveys, and data for **your organization only**, not other organizations. This is enforced by the system and is not an error.
- Only one role can be signed in at a time. If you previously signed in as a participant, you will see a prompt or need to sign out before entering the administration area.

## 1. First use: registration and sign-in

### 1.1 Register an account (once only)

1. Ask the platform's super administrator for a **one-time invitation code** (a string of letters and numbers that becomes invalid after use; do not share it with someone else).
2. Open `chatcircle.empact.cn/admin/register`.
3. Complete the following fields in order:
   - **Invitation code (邀请码):** Paste it exactly as provided.
   - **Username (用户名):** 4–20 letters, digits, or underscores. Uppercase letters are converted to lowercase automatically.
   - **Email (邮箱):** This cannot be changed after registration. Password recovery and verification-code sign-in depend on it, so use an email address you check regularly.
   - **Password (密码):** At least 8 characters; enter it again to confirm.
4. Click **Register and sign in (注册并登录)**. After registration succeeds, you enter the administration area directly and the invitation code becomes invalid immediately.

### 1.2 Everyday sign-in (two methods)

- **Password sign-in:** At `chatcircle.empact.cn/admin/login`, enter your username or email address and password, then click **Sign in (登录)**.
- **Email verification-code sign-in:** A quick way in if you forget your password. On the sign-in page, click **Sign in with an email verification code (邮箱验证码登录)** → enter your email address → click **Send email (发送邮件)** → enter the verification code from the email → click **Verify and sign in (验证并登录)**. The code is valid for 5 minutes.

### 1.3 Forgotten password

On the sign-in page, click **Forgot password (忘记密码)** → enter your email address → open the link in the email you receive → set a new password.

> ⚠️ Only accounts with a **verified email address** can recover their password by email. After registering, we recommend clicking **Verify email (验证邮箱)** at the bottom left of the administration area and completing verification (receive the email and follow its link). An unverified account can still sign in and work normally, but recovering a forgotten password will be more difficult.

### 1.4 Cannot sign in? Common causes

| What you see | Cause and action |
|---|---|
| A username/password error | Usernames are case-insensitive, but passwords are case-sensitive. Make sure you are not using a participant account as an administrator account. |
| A message that the organization is disabled (机构已停用) | The platform has disabled your organization. Contact the super administrator. |
| No email arrives | Check your spam folder first. If it still does not arrive, ask the super administrator to check whether the email address was entered incorrectly. |

## 2. What the administration area looks like

After sign-in, the fixed menu on the left has five items:

| Menu | Purpose |
|---|---|
| **Activities (活动)** | The main area for running activities: creation, registration review, check-in, surveys, and pairing. |
| **Training (培训)** | Publish listener training and manage training check-in. |
| **Dashboard (看板)** | View your organization's statistics: activity count, registrations, check-in rate, survey completion rate, and more. |
| **Exports (导出)** | Export and download data as Excel / CSV files. |
| **Audit logs (审计日志)** | Read your organization's administration records: who did what and when. Read-only. |

At the bottom left, you will also find **Verify email / Account security (验证邮箱 / 账号安全)** and **Sign out (退出登录)**. **Remember to sign out** after using a shared computer.

## 3. The complete activity workflow (the most common task; read this section in full)

### Step 1: Create an activity

Go to **Activities (活动)** → **Create activity (创建活动)** at the top right, then follow the five-step wizard:

1. **Basic information (基本信息):** Activity title, activity code (for example, `CC_SG_202609_01`; unique across the platform and unchangeable after creation), start/end times, venue, total capacity, and activity introduction.
   - Total capacity must be a **positive even number**. The system automatically divides it equally between speakers (倾诉者) and listeners (聆听者).
2. **Roles and registration (角色与报名):** Set registration start/end times (leave blank for no time limit), select **Open registration (开放报名)**, then configure which fields the registration form should collect.
   - **Name (姓名) is always enabled and required by the system**, for reviewing this activity's registrations, locating people at the venue, and displaying to their partner. It cannot be disabled.
   - To collect additional information, such as school or year of study, click **Add custom field (新增自定义字段)**.
3. **On-site settings (现场设置):** Enter the **Expected check-in opening time (预计签到开放时间)** (**a reminder for you only; check-in does not open automatically at that time**) and choose whether to **Enable on-site pairing (启用现场配对)** (this cannot be changed once pairing starts).
4. **Surveys (问卷):** Select the survey templates to use and set a phase (before the activity / on-site / after the activity) and expected opening time for each survey (again, **a reminder only; you open surveys manually using the buttons**).
5. **Preview and publish (预览与发布):** Review the details, then click **Create draft (创建草稿)**.

> 💡 An activity **is not publicly visible after creation while it is a draft**. Once published (or approved by the platform), it appears in the website's **Activity directory (活动广场)** and can also be accessed directly through its link or QR code. Check the activity content before publishing.

### Step 2: Publish the activity

Once the draft is ready, use the button at the top right of the activity detail page. There are two cases:

- If the button says **Publish directly (直接发布)** → click it and the activity becomes publicly accessible immediately.
- If the button says **Submit for platform review (提交平台审核)** → the platform requires your organization's activities to be approved first. Submit and wait for the platform's super administrator to approve it. If rejected, you can see the reason, make changes, and resubmit.

After publication, share the **public link** at the top of the activity detail page (such as `chatcircle.empact.cn/a/xxxxx`) with participants, or use it in a promotional post.

### Step 3: Review registrations

The activity detail page opens on the **Registration review (报名审核)** tab by default:

- New registrations appear under **Pending review (待审核)**. Click **Registration details (报名详情)** to see everything the applicant entered.
- Click **Approve (通过)** or **Reject (拒绝)**. When approving, you can also change the person's role (speaker/listener). The dropdown shows the remaining places for each role; if capacity is full, the system tells you it cannot approve the registration.
- Actions such as **Cancel (取消)** and **Revert to approved (回退为通过)** require a reason so they can be traced later.

> 🔒 For privacy, the review list shows participant identifiers by default and **does not show names**. If you need names and contact details, use **Exports (导出)** to export a contact list, or view them in the on-site workspace.

### Step 4: At the activity venue

On the day, open the activity detail page's **On-site workspace (现场工作台)** (data refreshes automatically in real time, and the connection reconnects automatically if interrupted):

1. **Open check-in:** Click **Open check-in (开放签到)** (also available under **Quick actions (快捷动作)** in the on-site workspace), then project or print the **fixed check-in QR code** from **Check-in management (签到管理)**. Participants scan it with WeChat or a browser to check in.
   - After successful check-in, the system automatically assigns an **on-site number** (speakers S01, S02…; listeners L01, L02…). Assigned numbers are never reused.
   - If someone cannot scan, go to **Check-in management (签到管理)** → **Administrator check-in (管理员补签)**, select the person, and enter a reason. To undo an incorrect check-in, click **Revoke (撤销)** (a reason is also required, and the record is retained).
2. **Start pairing:** Once most people have checked in, click **Start pairing (开始配对)**. The system automatically pairs the speakers and listeners present (pair numbers P01, P02…). If more people check in later, click **Fill remaining pairs again (再次补齐配对)**. To change an individual pairing, go to **Pairing management (配对管理)** → **Adjust pairs manually (手工调整配对)** and enter a reason.
3. **Open surveys:** In **Survey management (问卷管理)** (or the on-site workspace's quick actions), find the relevant survey, click **Open for responses (开放填写)**, and project its QR code. When the response period is over, click **End responses (结束填写)**.

### Step 5: After the activity

1. **Remind participants about surveys:** In the phase panel at the top of the activity detail page, click **Copy reminder text (复制催办文案)** beside each survey, then paste it into the WeChat group.
2. **View data / export:** The post-activity phase panel shows a review summary (check-in rate and completion of each survey). For detailed data, use the **Exports (导出)** menu.
3. **Close and archive:** Once no one else needs to register or check in, click **Close activity (关闭活动)** at the top right. After checking the data, click **Archive activity (归档活动)**. Archived activities are retained as read-only records, and their data can still be exported at any time.

## 4. Other features

### 4.1 Copy an activity and use organization templates

- At the top right of **Activities (活动)**, **Copy the previous activity (复制上一场活动)** copies the most recent activity's basic information, registration form, and surveys into a new draft. This is useful for recurring activities. Note: the activity code, check-in QR code, and survey links are all **regenerated**; historical registrations and check-ins **are not copied**.
- Each activity in the list has **Save as organization template (另存为机构模板)**, and each template row has **Create activity from template (从模板创建活动)**. A template is a reusable activity outline within your organization and cannot be published directly.

### 4.2 Training (listener training)

Go to **Training (培训)** → **Create training (创建培训)** and enter the title, code, time, venue, and description. Then open the training detail page:

1. Click **Publish training (发布培训)** at the top right.
2. At the venue, click **Open check-in (开放签到)** and project the training check-in QR code.
3. Afterward, click **Close training (关闭培训)**.

Two key points:

- **Who can check in:** Only accounts with an approved listener registration for any activity can scan to check in for training. Those without approval see a message.
- **Training completion applies across the platform:** Once a participant successfully checks in to training at any organization, their account counts as having completed training. They do not need to repeat it.

### 4.3 Dashboard

The **Dashboard (看板)** can be filtered by date range, activity status, and role. It displays 8 metrics: activity count, registration applications, approved registrations, rejected registrations, participant visits, unique participants, valid survey submissions, and survey completion rate. An activity detail table below includes **Manage (管理)** links to the relevant activities.

Metric notes:

- **Participant visits (服务人次)** counts check-ins (one person attending 3 activities counts as 3 visits); **Unique participants (去重参与人数)** counts distinct accounts.
- Draft activities, activities pending review, and rejected activities are excluded from statistics.

### 4.4 Export data

The **Exports (导出)** page is a five-step wizard: **select scope → select data (registrations/check-ins/pairs/surveys) → filter rows → select fields → select format**. Finally, click **Generate preview (生成预览)** to check the row count, then **Create export job (创建导出任务)**. After a short wait, click **Download (下载)** under **Export history (导出记录)** below.

The page also provides 7 ready-made presets (contact list, check-in list, on-site pairing list, full activity review, and others). Clicking a preset selects the fields for you.

> ⚠️ **Sensitive fields** (names, full phone numbers, registration answers marked sensitive, and so on):
> - You can export these fields only if the platform's super administrator has enabled **Sensitive exports (敏感导出)** for your organization. If it is not enabled, the preview tells you.
> - Exports containing sensitive information require you to select the **I understand (我已知晓)** confirmation checkbox, and every such export is recorded in the audit log.
> - **Exported files contain participants' personal information. Share them only with people who need them for work, store them securely after use, and do not casually forward them to WeChat groups or upload them to cloud drives.** See the [privacy operations manual](privacy-operations.md) for detailed compliance requirements.

### 4.5 Audit logs

The **Audit logs (审计日志)** page lets you search all your organization's administration records by date, operator, and action keyword (such as `export` or `checkin`). Logs cannot be edited or deleted and are retained for at least 1 year. They are useful for questions such as who deleted or changed a record.

## 5. Frequently asked questions (FAQ)

**Q: The “Expected check-in opening time (预计签到开放时间)” has arrived. Why did check-in not open automatically?**
A: All expected times are reminders only. Opening and ending check-in or survey responses **always require a manual button click**, to avoid opening them at the wrong time automatically.

**Q: Why do I see “Activity does not exist or access is not allowed (活动不存在或无权访问)”?**
A: The link probably belongs to another organization's activity. The system allows access only to your organization's data, and cross-organization access always shows “does not exist (不存在).” This is deliberate to avoid revealing another organization's information.

**Q: Can I change an activity or training code?**
A: No. The code is set at creation, is unique across the platform, and is used in QR codes and links.

**Q: I want to change my organization's name or turn off “Publication requires review (发布需要审核).”**
A: These are organization-level settings that **only the platform's super administrator can change**. Contact the platform operator.

**Q: Why can I not see applicants' names when reviewing registrations?**
A: This is part of the privacy design. If you need names, use the **Exports → Contact list (导出 → 联系名单)** preset, or view them in the on-site workspace.

**Q: Can I reopen an activity I closed by mistake?**
A: No. The workflow is Draft → Published → Closed → Archived and moves forward only. The page asks for confirmation before each action; read it carefully before clicking.

**Q: There are no buttons at the top right while an activity is pending review, taken down, or archived.**
A: That is expected. Approval, rejection, and taking down are super administrator actions. While an activity is pending review, wait for the result.

**Q: Can I use the administration area on a phone?**
A: Yes. Open `/admin/login` in a browser; the interface supports mobile screens. For exports and dashboards, a computer is recommended because the larger screen is easier to read.

## 6. Compliance boundaries (please remember)

1. Share only **public activity and survey links** externally. Do not send participants the administration address (`/admin`) or exported data files.
2. Store exports containing names or phone numbers securely, use them only as needed for work, and clear them promptly after use.
3. If a participant requests access to, correction of, or deletion of their personal information, or closure of their account, do not make a verbal promise. Refer the request to the platform using the [privacy operations manual](privacy-operations.md).
