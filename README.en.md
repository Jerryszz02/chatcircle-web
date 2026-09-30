# Chat Circles

[中文](README.md) | English

**The official activity platform for “Chat Circles,” a youth mental health nonprofit project**, operated centrally by Empact.

🌐 **Website: [chatcircle.empact.cn](https://chatcircle.empact.cn)**

---

## What is this website for?

In one sentence: **it brings registration, check-in, and surveys for nonprofit mental health support activities out of WeChat groups and scattered spreadsheets and into one website.**

Previously, students had to register through forms shared across different channels. Organization staff manually assembled attendance lists, called names at the venue, and chased participants for feedback afterward. With data scattered everywhere, it was difficult to tell how many people registered, how many attended, or how effective an activity was.

Now, the full activity workflow takes place on this website:

1. **Browse activities** — Open the activity directory and browse activities that participating organizations are recruiting for.
2. **Register** — Choose to join as a speaker or a listener (volunteer), then complete a registration form.
3. **Wait for approval** — Organization staff review the registration online, and you can see the result once it is approved.
4. **Attend in person** — Scan a QR code at the venue to check in without queuing to register your arrival.
5. **Give feedback** — Complete an online survey after the activity to help improve the project.

### Three groups use the platform

| Who you are | What you can do |
|---|---|
| **Participant** (a student or young person who wants to join an activity) | Browse activities, register, view review results, scan to check in, and complete surveys. One account works for all activities across all organizations. |
| **Organization staff** (a partner nonprofit organization) | Publish and manage your organization's activities, review registrations, control on-site check-in, release surveys, view dashboards, and export data. |
| **Listener volunteer** | In addition to registering for activities, attend listener training published by organizations. Successful training check-in is recorded on your account. |

### How your privacy is protected

- Participants sign in with a **username/phone number + password** and must verify their phone number when registering. Existing accounts can also sign in with a phone verification code. Organization administrators register with a one-time **invitation code** and need a username, email address, and password.
- Each activity registration collects a name for review, locating people at the venue, and displaying to that activity's partner. Ordinary statistics do not display names or phone numbers.
- Sensitive information you provide is marked for protection and is automatically excluded or masked when data is exported.
- Each organization can access only data within its permission scope. Personal activity records are managed for 2 years after the activity ends; account details are retained until an account closure request has been processed. The latest 2 local backups are retained, including backups made before deployment. You can request access, correction, deletion, or account closure under the [Privacy Policy](https://chatcircle.empact.cn/privacy).
- The organization responsible for processing personal information on this website is 上海井畅企业管理咨询有限公司 (its legal name in Chinese). ICP filing number: [沪ICP备2026002363号-2](https://beian.miit.gov.cn/).

---

## Administration tutorials (for organization and platform operations staff; no technical background required)

- **[docs/org-admin-guide.en.md](docs/org-admin-guide.en.md)** — Organization administrator tutorial: registration and sign-in, publishing activities, reviewing registrations, on-site check-in and pairing, surveys, and data exports.
- **[docs/super-admin-guide.en.md](docs/super-admin-guide.en.md)** — Super administrator tutorial: onboarding organizations and issuing invitation codes, approving and taking down activities, publishing posts, global dashboards and exports, and maintaining survey templates.

## Development and maintenance

Start with the **[handoff documentation index](docs/README.md)** to learn how to start the project locally, understand its business rules and change boundaries, then consult the API, testing, deployment, backup, and operations manuals for your task. Linked specialist documentation may be in Chinese.

- [Developer guide](docs/developer-guide.en.md): repository structure, local environment, architecture, and common changes.
- [Agent handoff](AGENTS.en.md): how agents take over the project, collaboration boundaries, and delivery requirements.
- [Maintenance backlog](docs/maintenance.md): unresolved work and items that require renewed acceptance checks.

The documentation describes the repository's current implementation. Verify the production version and service status live using the deployment manual. Historical requirements, phase plans, and fix records can be traced through Git history; they are not the starting point for current development.
