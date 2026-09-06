# Chat Circles 技术设计文档（V1）

> **2026-09-02 T7 更新：** T0–T6 已在默认分支实现，共享契约保持 `2026-08-28.t0-v1`。T7 自动化已覆盖全链路、权限、配对并发、导出准确性、断线恢复与发布配置；真实阿里云、真机、备份恢复和生产仍是上线门禁。

## 文档目的

把 PRD v0.3（评审修订版）需求基线与已确认技术决策，转换为 V1（里程碑 M0~M5）的实现与维护指引，使实现工程师不需要重新做架构决策即可开工。

本文档同时承担架构文档职责：整体形态、模块边界、信任边界与被否决方案均合并在此，**不单独生成 `architecture.md`**。

读者：后续实现工程师。阅读前不需要读过 PRD 全文——凡实现所依赖的需求结论，本文以"决策与契约"形式给出并标注需求来源（FR-*、AC-*、PRD 章节号）；PRD 原文仍为解决口径争议时的最终依据。

## 适用范围

- 覆盖：单仓结构、前端单应用三角色分区、PocketBase 后端（认证、collection API rules、pb_migrations、pb_hooks）、SQLite 存储、看板指标机制、环境划分与配置、备份策略落地、Docker Compose 部署形态。
- 开发范围：完整 V1，对应 PRD §15 的 M0（技术骨架）~ M5（生产交付）。
- 不覆盖：UI 视觉设计细节、T0 三个标准字段之外的具体报名字段内容、标准问卷模板题目内容、上线后的长期维护与责任划分。

## Plan 或项目证据

| 证据 | 位置 | 本文档使用的结论 |
| --- | --- | --- |
| PRD v0.3（评审修订版） | `docs/Chat_Circles_活动与问卷平台_PRD_v0.3.docx` | 需求基线：数据模型（§9）、功能需求 FR-*（§6）、状态机（§4）、导出规范（§10）、安全审计（§11）、技术架构与部署（§12）、非功能需求（§13）、验收标准 AC-01~23（§14）、里程碑 M0~M5（§15）。本版已确认的规则在开发阶段不得再次默认变更 |
| 已确认技术决策 | 项目启动共识 + 当前代码 | 响应式 Web（React 18 + Vite + TypeScript，手机优先）+ PocketBase（后端/认证/SQLite 存储）+ Docker 部署；正式域名 `chatcircle.empact.cn`；GitHub 私有仓库 `chatcircle-web` 已创建 |
| 仓库现状 | 项目根目录，2026-09-02 | `origin/main@f2436f3` 已包含 T0–T6；T7 分支自动化验收通过。本文主体源于开发前设计，代码现状与本文冲突时以代码和 [开发者指南](../developer-guide.md) 为准 |

## 非目标

以下事项在 V1 技术设计中明确不做（依据 PRD §2.2、§16，以及本文档的合并范围约定）：

- 不设计参与者账号找回与密码重置；凭据丢失的官方口径是"用新用户名重新注册"，由此产生的同一自然人多账号不合并（PRD §5.7）。
- 不设计候补名单、营销短信、微信群自动发消息或推送。2026-08-27 专项升级新增**参与者手机号验证码**与**现场配对**；验证码走阿里云短信认证，活动通知短信仍不在本期范围。管理员邮箱验证与找回继续使用 PocketBase 邮件能力。
- 不设计统计分析（均值、效应量、p 值、NPS 等）、LLM 编码、自动报告、PDF/PPT 生成；仅以稳定 `question_code`、规范化导出和可扩展看板机制预留后续能力。
- 不设计机构独立部署、独立数据库、独立域名或子域名；仅在架构上不自堵"host → organization 映射"的后续扩展（PRD §12.2）。
- 不设计任何业务数据的永久删除路径（无硬删除，PRD FR-AUD-001）。
- 不设计动态签到二维码（固定二维码 + 开放状态控制，动态码留作后续版本）。
- 不引入 PRD 技术基线之外的持久化与基础设施组件（不换 PostgreSQL、不加 Redis/MQ/独立对象存储服务；备份的异地目标见「待确认」）。
- 不设计问卷答卷"退回重填"（v0.3 已移除；管理端仅可作废）。
- 培训体系（2026-08 PRD 外扩展）本次不做：培训作为聆听者报名门槛（仅记录与展示，后续可加活动级开关）；培训报名/名额体系；审核报名时向管理员展示跨机构「已培训」标记（资格数据跨机构对管理员不可见，需要时另开端点）。

## 实现指引

### 5.1 整体架构

形态：**单仓 monorepo，一套 Compose 部署**。前端为单个 React SPA，按路由划分为三个角色端；后端为单个 PocketBase 实例，承载认证、业务 API、权限规则与 SQLite 存储；schema 由 `pb_migrations` 版本化管理，服务端业务规则集中在 `pb_hooks`；反向代理负责 `chatcircle.empact.cn` 的路由与 TLS。

```
浏览器（手机优先）
   │  HTTPS
反向代理（TLS 终结，chatcircle.empact.cn）
   │
PocketBase 容器 ── 静态资源：pb_public/（前端 build 产物，同源伺服）
   │            ── /api/*：PocketBase API + pb_hooks 自定义端点
SQLite 数据文件 + pb_data 上传文件（命名数据卷，与镜像分离）
   ▲
备份 service（Compose 内，每日定时，结果写审计）
```

组件职责与信任边界（依据 PRD §12.1、§11.2）：

| 组件 | 技术 | 职责 | 信任边界要点 |
| --- | --- | --- | --- |
| 前端 SPA | React 18 + Vite + TypeScript | 三个角色端共用：参与者端（手机优先）、机构管理端、超级管理端 | 只做展示与交互引导；不是权限防线 |
| PocketBase | Go 二进制 + JS `pb_hooks` | 认证、业务 API、collection API rules 行级权限、hooks 服务端业务规则、文件存储 | **唯一可信层**：机构隔离、状态机、名额硬校验、幂等、审计写入全部在此强制执行 |
| SQLite | PocketBase 内嵌 | V1 统一业务数据库 | 数据文件与上传文件放持久化卷；容器重建不得覆盖 |
| 反向代理 | 选型待确认 | 域名路由 + TLS | 生产禁止明文 HTTP（PRD §11.2） |
| 备份 service | Compose 内独立容器 | 每日备份、30 天滚动保留、结果上报审计 | 失败触发超级管理后台告警 |

关键架构决策与被否决方案（合并架构文档内容）：

| 决策 | 结论 | 否决的备选 | 理由 |
| --- | --- | --- | --- |
| 前端形态 | 单 SPA 按角色路由分区 | 三个独立前端应用 | 共享 PocketBase client、类型与组件；一次构建一次部署；三端无交叉页面，路由守卫即可分流 |
| 后端形态 | PocketBase + `pb_hooks` | 独立 Node/Java 后端框架 | PRD 技术基线已确认 PocketBase；内置认证/文件/SQLite/迁移，hooks 足以承载 V1 全部服务端规则 |
| 数据库 | SQLite | PostgreSQL / MySQL | PRD 基线；V1 规模为"单场数百人低并发"（§13）。"SQLite 单点增长"是 PRD §16.1 已记录风险，后续按实际容量评估迁移 |
| 权限可信层 | 全部在服务端（API rules + hooks） | 依赖前端隐藏或路由守卫 | PRD §11.2/§12.2：前端不得成为唯一权限控制；跨机构 ID、筛选、URL、API 参数伪造均须返回无权限 |
| 部署拓扑 | 单域名、单 Compose、单逻辑库 | 多实例、机构独立部署 | PRD §12.1：一套生产环境、一个逻辑统一数据库、一个超级管理后台 |
| 数据层级 | 平台 → 机构 → 活动 | 引入"项目 Project"层级 | PRD §4.1：V1 不设项目层级；`activities.group_tag`（可空）为预留分组字段，V1 不消费 |

### 5.2 单仓目录结构约定

```
chatcircle-web/
├── frontend/                       # React + Vite + TS 单应用
│   ├── src/
│   │   ├── features/
│   │   │   ├── participant/        # 参与者端：页面与该端专有逻辑
│   │   │   ├── admin/              # 机构管理端
│   │   │   └── superadmin/         # 超级管理端
│   │   ├── shared/                 # 跨端共享：PB client、record 类型、枚举、
│   │   │                           #   通用 UI 组件、metrics 注册表、工具函数
│   │   ├── router.tsx              # 路由表 + 角色守卫
│   │   └── main.tsx
│   └── （构建配置、package.json）
├── backend/
│   ├── pb_migrations/              # 全部 schema 变更：集合、字段、索引、API rules，版本化
│   ├── pb_hooks/                   # 全部服务端业务规则（JS），按领域分文件
│   │   ├── auth.pb.js              # 存量参与者登录、登录限流、邀请码注册
│   │   ├── phoneauth.pb.js         # 手机号验证码登录/注册、存量绑定与双验证换绑
│   │   ├── registrations.pb.js     # 报名状态迁移 + 名额事务硬校验
│   │   ├── checkins.pb.js          # 签到开放/关闭、自助签到、补签/撤销
│   │   ├── trainings.pb.js         # 培训生命周期、培训签到开放/关闭、自助签到、补签/撤销（2026-08 培训体系）
│   │   ├── surveys.pb.js           # 问卷资格校验、草稿/提交/作废
│   │   ├── exports.pb.js           # 导出任务、范围校验、文件下载鉴权
│   │   ├── metrics.pb.js           # 看板聚合查询
│   │   ├── live.pb.js              # T3 单活动事务快照 + Realtime topic 最小权限守卫
│   │   └── lib/                    # 共享函数的「契约标准源」（jsonError/requireAuth/writeAudit 等）：
│   │                               #   PocketBase 0.28 JSVM 各 hooks 文件作用域完全隔离（无跨文件
│   │                               #   共享、无 ES module），各 handler 自包含、将所需函数原样内联使用
│   └── pb_public/                  # 前端 build 产物（部署期填充，由 PocketBase 同源伺服）
├── deploy/
│   ├── docker-compose.yml          # base + 各环境 override
│   ├── Dockerfile
│   └── （反向代理配置、备份脚本）
└── docs/
```

强制性约定：

- **schema 只能经由 `pb_migrations` 变更**，禁止在生产环境手工用 admin UI 改结构（PRD §13"数据库结构通过迁移版本化"；标准模板版本不可变）。
- **业务规则只能写在 `pb_hooks` / collection API rules**。前端可以做同样的校验以改善体验，但不得成为唯一防线。
- 当前集合 record 类型、状态枚举、`metric_key` 放 `src/shared/`，与 `pb_migrations` 手工同步。T0 冻结契约单独放 `frontend/src/shared/api/accountEvent.ts`；其中 T1 手机号认证、T2 配对后端与 T3 汇总/Realtime 已落地，其余类型仍只表示后续实现必须复用的机器名/类型，不表示对应 migration/hook 已存在。
- 手机号、配对、快照、Realtime 和导出 v2 的端点、权限、幂等、错误与 v1 兼容契约不在本文重复，统一见 [api-design.md](api-design.md)。
- hooks 文件名仅为建议切分，实现时可调整，但"按领域分文件 + 共享逻辑以 `lib/` 为契约标准源"的边界不变。注意（0.28 JSVM 实测）：`lib/` 不能跨文件引用——各 hooks 文件作用域隔离，handler 只能使用自身闭包内标识符与 JSVM 内建全局，共享函数须在 handler 内内联（与 `lib/` 同源，勿手工改副本）。

### 5.3 三个角色端：职责与路由分区

职责（依据 PRD §3、§12.1）：

| 端 | 使用者 | 首要设备 | 职责 |
| --- | --- | --- | --- |
| 参与者端 | 倾诉者 / 聆听者 | 手机（360px 宽无横向滚动，PRD §13） | 首页（项目介绍）、活动广场页、公开活动详情、手机号验证码登录/注册、存量用户名账号迁移、提交报名、"我的"中心（手机号管理、报名状态、问卷入口、已提交答案）、扫码签到、问卷填写与只读答案查看 |
| 机构管理端 | 机构工作人员 | 桌面为主、响应式 | 活动创建/编辑/发布/关闭/归档、报名表与问卷配置、报名审核/角色修改/状态回退、签到控制台（开放/关闭/补签/撤销）、本机构看板、本机构导出、本机构审计日志只读检索 |
| 超级管理端 | Empact（全平台唯一账号） | 桌面 | 机构创建/停用/开关配置、一次性邀请码生成与撤销、活动发布审批/驳回/下架、全局看板、全局导出、全局审计检索、备份失败告警 |

路由分区约定（本节为设计约定：PRD 未规定 URL 形态，实现按此执行，变更须同步更新本文档）：

参与者端（`/`，手机优先）：

| 路由 | 页面 | 服务端前置条件 |
| --- | --- | --- |
| `/` | 首页：品牌介绍 + 现有活动最近 2 场 + 往期活动公开推文最近 2 篇 + Our Impact + 各独立页入口 | 无；未登录可看；活动来自公开 activities 端点，往期内容来自 posts 集合 |
| `/activities` | 活动与问卷页：活动广场（公开活动列表，点击进详情/报名）+ 问卷入口（登录后显示本人可填问卷，未登录显示扫码指引）；支持 `#activities`/`#surveys` 锚点 | 无；未登录可看，活动数据来自 `GET /api/cc/public/activities` |
| `/activities/past` | 往期活动：后台公开推文完整列表，置顶优先、其余按发布时间倒序 | 无；未登录可看，仅 `status=visible` 推文（直读 posts 集合，rule 过滤 hidden） |
| `/a/:activityId` | 公开活动详情 | 活动已发布；未登录可看（FR-ACT-003） |
| `/a/:activityId/register` | 报名链路（内嵌手机号认证入口） | 报名开放中；登录后提交 |
| `/login` | 平台通用登录页 | 手机号验证码登录/注册为主入口，另提供仅已有账号可用的用户名迁移；支持 `redirect` 参数，从活动链接跳转登录后回到原目标 |
| `/me` | "我的"中心 | 参与者会话 |
| `/checkin/:token` | 固定签到二维码的落地页 | 登录 + 报名已通过 + 签到开放中 |
| `/trainings` | 聆听者培训页：流程说明 + 资质标记 + 培训列表 + 我的签到状态 | 参与者会话；培训信息仅 eligible（存在 approved 聆听者报名）下发 |
| `/training-checkin/:token` | 培训签到二维码的落地页 | 登录 + approved 聆听者报名 + 培训已发布 + 签到开放中 |
| `/survey/:qrToken` | 问卷填写 / 草稿 / 已提交答案 | 登录 + 报名已通过 + 角色匹配 + 问卷开放中（FR-SUR-006） |

机构管理端（`/admin` 前缀，需 `admin_accounts` 会话）：

| 路由 | 页面 |
| --- | --- |
| `/admin/login` | 管理员登录 |
| `/admin/register` | 邀请码注册（邀请码 + 用户名 + 邮箱 + 密码） |
| `/admin/activities`、`/admin/activities/:activityId` | 活动列表与详情（含报名审核、签到控制台、问卷管理子页） |
| `/admin/trainings`、`/admin/trainings/:trainingId` | 培训列表/创建与详情（发布/关闭、签到管理：二维码、开放/关闭、名单、补签/撤销） |
| `/admin/dashboard` | 本机构看板 |
| `/admin/exports` | 导出（本机构全部或单活动） |
| `/admin/audit` | 本机构审计日志只读检索 |

超级管理端（`/super` 前缀，需 PocketBase superuser 会话）：

| 路由 | 页面 |
| --- | --- |
| `/super/login` | 超级管理员登录 |
| `/super/organizations` | 机构管理、机构开关、邀请码生成/撤销 |
| `/super/approvals`、`/super/activities` | 活动发布审批、全部活动监管/下架 |
| `/super/dashboard`、`/super/exports`、`/super/audit` | 全局看板、全局导出、全局审计 |
| `/super/system` | 备份状态与失败告警 |
| `/super/posts` | 内容推文管理：列表/新建/编辑/置顶/显隐（仅超管入口，机构管理员无入口；2026-08 后端改版，前端已实现） |

分区原则：

- 三种会话（`participant_accounts` / `admin_accounts` / PocketBase `_superusers`）互不通用；路由守卫按认证记录类型分流，参与者会话不具备任何管理后台权限（PRD §3.2）。首页「管理入口」仅提供机构/超级管理端登录页链接作统一导航，不构成权限入口。
- 路由守卫只是 UX 引导；真正的隔离在 collection API rules 与 hooks（见 §5.5）。
- 活动与问卷页（`/activities`）以 `GET /api/cc/public/activities` 公开展示已发布/已关闭活动（对 FR-ACT-002「活动仅链接/二维码可达、无公开广场」的实现期偏离，初随首页落地，后拆为独立页）；**问卷仍不出现在任何公开列表**，仅二维码/链接可达（该页问卷区只展示登录者本人可填的问卷）。
- 签到二维码内容固定指向 `/checkin/<checkin_qr_token>`，有效性由签到开放状态控制而非二维码本身（FR-CHK-001/002）；培训签到二维码指向 `/training-checkin/<checkin_qr_token>`（token 均由服务端生成）；每份问卷独立 `qr_token`（PRD §9.1 `activity_surveys.qr_token`）。

### 5.4 认证模型

三类账号（依据 PRD §3、§9.1、FR-AUTH-009）：

| 账号 | PocketBase 载体 | 创建路径 | 数据范围 |
| --- | --- | --- | --- |
| 参与者 `participant_accounts` | auth collection（不绑 `organization_id`，FR-AUTH-003） | 手机号验证码验证成功后创建；已有用户名账号只登录并绑定，不允许从迁移入口建号 | 仅本人记录 |
| 管理员 `admin_accounts` | auth collection（含 `organization_id`） | 一次性邀请码注册 | 仅本机构 |
| 超级管理员 | PocketBase `_superusers` | 初始部署（建站）时以命令创建，全平台仅一个 | 全平台 |

**参与者手机号认证与存量迁移**（专项 PRD §3、验收 AC-06/AC-21）：

- 新账号统一通过 `request-code` → `verify-code` 验证手机号后创建；手机号 HMAC 唯一索引与事务保证重试、并发不会产生重复账号。
- 存量兼容端点 `POST /api/cc/auth/participant` 输入 `{ username, password }`，仅校验迁移前已存在的用户名账号：用户名先按 4–20 位字母/数字/下划线规则校验并小写归一化；未知用户名与错误密码返回相同 `INVALID_CREDENTIALS`，不创建账号、不签发 token；成功后必须继续走 `bind-phone`。
- 会话：`participant_accounts` 的 auth token 有效期设为 30 天（FR-AUTH-006）；主动退出立即失效。
- 存量登录按 username + 来源 IP 及来源 IP 双轴限流；手机号验证码按手机号 HMAC、来源 IP、设备会话多轴限流。
- 密码只存不可逆哈希；数据库、日志、审计、导出均不得出现明文（FR-AUTH-004）。

**管理员邀请码注册**（FR-ORG-002/003，邀请码状态机见 PRD §4.2，验收 AC-02；邮箱认证为 2026-08 后端改版扩展，验收 AC-24）：

- `admin_invites` 只存 `token_hash`（邀请码明文的哈希），不存明文；`status ∈ {未使用, 已使用, 已撤销, 已过期}`；`expires_at` 默认生成后 7 天，生成时可调整。
- 自定义端点 `POST /api/cc/auth/admin-register`（输入邀请码明文 + 用户名 + **邮箱** + 密码）在**单个事务内**：校验邀请码存在、未使用、未撤销、未过期 → 校验邮箱格式（trim + 小写归一化，非法返回 `400 INVALID_EMAIL`）并查重（重复返回 `400 EMAIL_TAKEN`，schema 唯一约束兜底） → 创建 `admin_accounts`（写入 email、`verified=false`、`emailVisibility=false`）并绑定 `organization_id` → 将邀请码标记为已使用 → 写审计（metadata 不含邮箱明文）。并发使用同一邀请码只能成功一次。响应形态不变（返回 `{record}`）。
- **发送验证邮件不在注册事务内做**（外部副作用，避免"已回滚但邮件已发"）：由前端在注册成功后调用 PB 内置 `request-verification` 触发，见下方「管理员邮箱认证」。
- 管理员用户名是否套用参与者同一套规则，PRD 未明确，见「待确认」。
- 机构被停用后其管理员不能进入业务后台，历史数据保留（FR-ORG-001）：hooks 与 API rules 校验 `admin_accounts.status` 与所属机构 `status`。

**管理员邮箱认证**（2026-08 后端改版，PRD 外扩展，验收 AC-24）：`admin_accounts` 的 `passwordAuth.identityFields = ['username', 'email']`，并启用 PB 原生 OTP。登录方式三种：用户名+密码、邮箱+密码、邮箱验证码。以下均为 **PocketBase 内置端点**，hooks 不重写认证逻辑，只做限流与找回门控（实现于 `mailguard.pb.js`）：

| 端点 | 使用契约 |
| --- | --- |
| `POST /api/collections/admin_accounts/auth-with-password` | identity 支持用户名或邮箱（identityFields 配置） |
| `POST /api/collections/admin_accounts/request-verification` / `confirm-verification` | 注册后邮箱验证：用户在 `/admin/verify-email` 主动申请邮件，点击落地页确认后经 confirm-verification 完成验证 |
| `POST /api/collections/admin_accounts/request-otp` / `auth-with-otp` | 邮箱验证码登录；OTP 认证成功即已证明邮箱所有权，账号同步置 `verified=true`（若 PB 原生不自动置位，由 hooks 在认证成功钩子里补齐） |
| `POST /api/collections/admin_accounts/request-password-reset` / `confirm-password-reset` | **仅 `verified=true` 的邮箱放行**；未验证账号请求时静默拦截——返回 204 但不发邮件、不放行，写审计 `auth.password_reset.suppressed`，避免账号枚举 |

- 统一限流约定：request-verification / request-otp / request-password-reset 三类发信/验证码请求按 **per-email 3 次/小时 + per-IP 20 次/小时** 滑动窗口限流（复用 authguard 的限流模式）。**验证/找回超限静默 204，OTP 超限返回 200 + 随机 otpId，并写审计 `auth.mail.throttled`，不发信、不返回 429**——这些钩子仅在邮箱存在时触发，若超限响应 429，探测者可用「是否 429」区分已注册邮箱与不存在邮箱，形成账号枚举 oracle（响应须与各端点正常/不存在的状态码和形状一致）。
- 换邮箱走 PB 内置 `requestEmailChange` 流程；直连 update 修改 `email` 由 guards.pb.js 禁止。
- 发信通道：PocketBase 无托管邮件服务，SMTP 在 PB Settings 手工配置（用户方提供发信邮箱），凭据不入库、不进文档，见「待确认」#18。

**超级管理员**（FR-AUTH-009）：

- 初始部署时创建（如 `pocketbase superuser create`，以所选定 PocketBase 版本的命令为准）；初始凭据的生成与安全下发流程见「待确认」，凭据一律不写入仓库与本文档。
- V1 不提供创建/停用/更换超级管理员的产品界面，也不提供任何角色重置参与者凭据的入口（PRD §3.2）。
- 超级管理端点使用 superuser 鉴权，**不复用**机构管理员权限规则（PRD §12.2）。

会话策略对照（PRD §12.4）：

| 项 | V1 规则 | 落地 |
| --- | --- | --- |
| 参与者会话 | 默认保持 30 天，主动退出立即失效 | auth token duration = 30 天 |
| 管理后台会话 | 不因"连续无操作"自动退出；仍需令牌过期与主动退出 | 不做 idle timeout；token 过期时长数值待确认 |
| 超级管理员会话 | 同上 | 同上 |

### 5.5 关键服务端规则与实现位置

总原则：每条业务不变量都有唯一的服务端强制点；前端重复实现仅用于体验。以下端点路径为设计约定，可在 hooks 内调整命名，但**校验位置与事务语义不得改变**。

| 规则 | 需求来源 | 实现位置 | 机制 |
| --- | --- | --- | --- |
| 机构隔离 | FR-ORG-006、§12.2、AC-03 | collection API rules + hooks | 机构业务表的 list/view/create/update rule 强制 `auth.organization_id` 匹配；hook 端点忽略客户端传入的机构参数，由服务端按登录身份注入；跨表查询必须能沿 `activity → organization` 等关系可靠反查（§9.2） |
| 报名状态迁移矩阵 | §4.4、FR-REG-007/008、AC-07 | `POST /api/cc/registrations/:id/transition` | 白名单硬编码：待审核→已通过/已拒绝；已通过→已取消；已拒绝→已通过；已取消→已通过。**表外迁移一律拒绝**；回退与取消必须带 `reason`；记录操作者、时间、前后状态与原因 |
| 名额事务硬校验 | FR-REG-005、FR-ACT-006/007、AC-08 | 同上 transition 端点，事务内 | 事务内重读 `capacity_total/capacity_speaker/capacity_listener` 与当前已通过计数（总名额 + 目标角色名额），校验通过才提交；审核通过、角色修改、状态回退三条路径共用该校验；并发审核由事务串行化保证不超额 |
| 名额修改下限 | FR-ACT-006 | activities 更新 hook | `capacity_*` 不得低于当前已通过人数 |
| 签到唯一性 | FR-CHK-003/004、AC-09/AC-20 | checkins 唯一索引 + hook | `(activity_id, participant_id)` 唯一索引，每活动每人一行，状态 ∈ 未签到/已签到/已撤销；自助签到前校验报名已通过且场次开放；**重复扫码幂等返回已有记录**，不报错不新建 |
| 补签 / 撤销签到 | FR-CHK-005、AC-10 | checkins hook | 仅管理端；必须填 `reason`；写审计；只改状态不删行 |
| 分角色报名问卷校验 | 2026-08 扩展（PRD 外） | registrations 报名提交端点 | 按 `activity_role` 计算适用字段（`role_scope ∈ {both, 该角色}`）；必填与格式校验仅针对适用字段；对不适用字段提交答案返回 400 `field_not_applicable`；公开详情端点下发字段含 `role_scope` |
| 培训状态机 | 2026-08 扩展（PRD 外） | `POST /api/cc/trainings/{id}/publish|close` + guards | draft → published → closed；幂等同态返回（already=true）；直连创建强制 draft、禁直连改 status/organization_id/checkin_qr_token；写审计（training.publish/close） |
| 培训签到资格与唯一性 | 2026-08 扩展（PRD 外） | `POST /api/cc/training-checkin/self`、`POST /api/cc/training-checkins/manual` | 资格 = 存在 approved 聆听者报名（账号级、全平台通用，否则 `listener_not_approved`）；须培训 published 且签到开放中（未开放 `checkin_not_open` / 已结束 `checkin_closed`）；每培训每人仅一条 valid，事务内查重，重复扫码/补签幂等返回已有记录 |
| 培训补签 / 撤销与候选人 | 2026-08 扩展（PRD 外） | `/api/cc/training-checkins/manual`、`GET /api/cc/trainings/{id}/checkin/manual-candidates`、`POST /api/cc/training-checkins/{id}/revoke` | 仅管理端；补签/撤销 `reason` 必填 + 写审计；撤销只改状态不删行，撤销后可重签；候选人 = 全平台 approved 聆听者按参与者去重 |
| 培训信息可见性 | 2026-08 扩展（PRD 外） | `GET /api/cc/me/trainings`、`GET /api/cc/me/overview` | 未 eligible（无 approved 聆听者报名）时培训列表恒空；eligible 返回全平台 published 培训 + 本人有出席记录的 closed 培训（含 my_attendance）；不下发 `checkin_qr_token`；overview 响应含 `has_approved_listener_registration`（供「我的」中心培训入口显隐） |
| 问卷提交幂等与锁定 | FR-SUR-006/008、AC-12/AC-20 | submissions 唯一约束 + hook | `(activity_survey_id, participant_id)` 唯一；草稿可编辑、正式提交即锁定；重复提交返回原记录；资格四条件（登录、报名已通过、角色匹配、开放中）服务端逐项校验；未签到不强制（PRD §5.6） |
| 答卷作废 | FR-SUR-010 | submissions hook | 状态→已作废，原记录保留 + 审计；常规统计与导出口径排除作废记录 |
| 导出范围服务端校验 | FR-EXP-003/004、AC-16/17 | exports hook 端点 | 服务端按身份计算允许范围：管理员=本机构全部或指定单活动；超级管理员=全平台/机构/单活动；敏感导出校验机构 `allow_sensitive_export` 开关 + 二次确认标记 + 审计；生成 `export_jobs` 记录（导出人、范围、时间、是否含个人信息、文件校验信息，§10.3） |
| 导出内容过滤 | FR-EXP-002、§10.2 | exports hook 内生成器 | 普通导出按 `is_sensitive` 标记排除或掩码（**不依赖字段名判断**），主体用 `participant_id` 关联，不含用户名/姓名/手机号 |
| 导出文件访问 | FR-EXP-005、§10.3 | 受保护目录 + 鉴权下载端点 | 文件不自动失效；下载 URL 不可连续可猜；仅鉴权后台可下载 |
| 审计日志 | FR-AUD-001~005、§11.3 | `audit_logs` collection + hooks 内统一 `writeAudit()` | API rules 禁止普通管理员创建/修改/删除；机构管理员只读本机构，超级管理员全局；写入范围至少含：敏感导出、补签/撤销签到、答卷作废、活动审批/下架、机构配置变更、报名状态回退、邀请码生成/撤销/使用、备份与恢复；与业务写操作同事务 |
| 活动发布状态机 | §4.3、FR-ACT-004、AC-04 | activities hook | 草稿→（机构开启审核时：待平台审核→）已发布/已驳回→已关闭/已下架/已归档；批准/驳回/下架仅 superuser；写 `activity_approvals` + 审计；下架后公开入口不可访问、历史保留 |
| 公开活动可见性与报名口径 | §4.3、FR-ACT-003 | activities hook：`GET /api/cc/public/activities`（活动广场页列表）与 `GET /api/cc/public/activities/:id`（详情） | 仅 `published`/`closed` 公开可见（草稿/待审核/已驳回/已下架/已归档一律不下发，详情按 404 处理）；列表按开始时间倒序；报名开放状态（`open` + 未开放 `reason`：closed/not_started/ended/full）与剩余名额（`capacity_total` − 当前已通过数）口径在列表与详情两端点保持一致 |
| 内容推文 posts 可见性与校验 | 2026-08 后端改版（PRD 外扩展）、AC-25 | posts 集合 API rules + posts.pb.js | 与 activities 完全无关的独立集合：listRule/viewRule 为 `status = 'visible'` 或超管（匿名与普通用户仅见可见项）；create/update 仅 `_superusers`（机构管理员无入口）；deleteRule 关闭（无硬删除，隐藏即删除）；hooks 校验正文（`body_md`）与外链（`external_url`）至少填一个、外链仅允许 http/https；`status` 首次变为 visible 且 `published_at` 为空时写入当前时间，之后不因隐藏/再可见而改；创建/更新写审计（`post.create` / `post.update`） |
| 公开 Outcome 指标 | 2026-08 后端改版（PRD 外扩展）、AC-26 | metrics.pb.js：`GET /api/cc/public/outcome` | 公开只读、无需登录、无参数、无手工维护：返回 `{ activity_sessions, service_visits, partner_organizations }` 三个累计值，口径复用 §5.6 指标注册表（`partner_organizations` 为新增口径） |
| 报名/签到/问卷接口幂等 | §13、AC-20 | 上述各端点 | 依赖唯一约束 + 状态判断：网络重试或重复点击返回既有正式记录，不产生重复 |
| 无硬删除 | FR-AUD-001、AC-18 | API rules | 全部业务集合关闭 delete 权限；只能归档、停用、作废或状态变更 |
| 参与者凭据保护 | §3.2 | hooks + 管理端 UI | 机构管理员（含任何角色）无修改参与者用户名/密码的入口；hooks 不开放此类端点 |

事务实现说明：名额校验、邀请码消费、状态回退必须在 PocketBase 提供的事务 API（JS hooks 的 `runInTransaction`，具体名称以所选 PocketBase 版本为准，版本见「待确认」）内完成"读—校验—写"，不得先查后写分两请求执行。

### 5.6 看板可扩展指标组件

目标（FR-DASH-005、§7.2）：指标组件、筛选和聚合口径不硬编码为单一页面；**新增指标不需要重构全部页面和数据表**。

实现思路：

- 指标以配置定义：`{ metric_key, dataSource, aggregation, filters, displayType }`（PRD §7.2 原话要求）。
- 前端：`src/shared/metrics/` 维护指标注册表与通用渲染组件（指标卡、趋势、角色拆分、活动明细表）。看板页面 = 顶部筛选条（时间范围；超级管理员额外有机构筛选）+ 指标配置数组的渲染结果，不出现写死的单指标卡片。
- 后端：`pb_hooks` 暴露聚合端点（约定 `GET /api/cc/metrics/:metric_key`，筛选参数同 query），按 `metric_key` 分发到对应聚合查询；服务端按身份注入 `organization_id` 范围——管理员恒为本机构，超级管理员可全平台并按机构筛选（FR-DASH-001）；筛选统一作用于全部卡片和图表（FR-DASH-004）。
- 新增一个指标的成本 = 注册表加一条配置 + 服务端加一个聚合函数；页面结构与数据表结构均不变。
- 口径红线：看板口径与导出口径一致（FR-DASH-002、M4 退出条件）；去重指标界面必须注明"去重参与账号数"及多账号不合并的口径说明（§7.1）。

V1 指标注册表初始项（口径原文来自 PRD §7.1）：

| metric_key | 口径 | 聚合方式 |
| --- | --- | --- |
| `activity_sessions` | 筛选范围内处于已发布/已关闭/已归档的活动数；草稿、待审核、已驳回不计 | count |
| `applications` | registration 记录总数；可按倾诉者/聆听者拆分 | count |
| `approvals` | 当前状态=已通过的报名数；取消后不计、回退恢复后重新计入 | count |
| `rejections` | 当前状态=已拒绝的报名数；无候补 | count |
| `service_visits` | 有效签到记录数（服务人次；一个账号三场活动计 3 人次） | count |
| `unique_participants` | 有效签到中的 `participant_id` 去重；同一自然人多账号不合并 | countDistinct |
| `survey_submissions` | 有效已提交答卷数；作废不计 | count |
| `survey_completion_rate` | 当前报名仍为 approved 且角色符合者中的有效已提交人数 ÷ 当前报名 approved 且角色符合人数；分子与分母使用同一当前资格集合，答卷作废或报名取消/回退后同步排除；分母为 0 返回 null，比例不得超过 1 | ratio |
| `partner_organizations` | 状态=active 的机构数（合作伙伴口径；2026-08 后端改版新增） | count |

公开 Outcome 端点（2026-08 后端改版，PRD 外扩展，验收 AC-26）：`GET /api/cc/public/outcome` 面向首页公开成效区块，无需登录、无参数、无手工维护，返回 `{ activity_sessions, service_visits, partner_organizations }` 三个累计值，口径直接复用上表注册表。注意：`activity_sessions` 此处含 archived，与公开活动列表/详情 viewRule 的可见范围（仅 published/closed）是两回事——Outcome 是累计宣传口径，不随活动下架/归档而扣减。服务端三次 count 查询，不加缓存。

### 5.7 环境划分与配置管理

环境（证据：M0 退出条件"本地与测试服务器可一键启动"、AC-19"测试环境恢复"、§12.1 正式架构）：

| 环境 | 用途 | 入口 | 数据 |
| --- | --- | --- | --- |
| local | 日常开发 | `localhost` | 种子/测试数据 |
| staging | 测试服务器：验收、机构越权自动化测试（AC-03）、备份恢复演练（AC-19） | 独立入口域名/端口，具体待确认 | 独立测试数据，独立于生产卷 |
| production | 正式服务 | `chatcircle.empact.cn`（HTTPS） | 生产命名卷 |

配置管理约定：

- 所有环境差异走环境变量：`.env.example` 入库，真实 `.env` 不入库；secrets（超级管理员初始凭据、备份目标存储凭据等）只在部署时注入，不写入仓库、文档与审计日志。
- Compose 采用 base 文件 + 各环境 override 表达差异；M0 的"一键启动"指 `docker compose up` 同时拉起 PocketBase（含迁移执行与模板初始化）与前端产物。
- 部署拓扑：前端 build 产物放入 PocketBase 容器的 `pb_public/` 由 PocketBase **同源伺服**，避免 CORS 与多服务编排；反向代理只做 TLS 与域名路由。若后续拆分为独立静态服务，须更新本文档。
- 生产 app 不向 host 发布 PocketBase 端口，只在 Docker 私网供 Caddy/backup 访问；部署健康检查复用 compose 的 app healthcheck，以容器 `State.Health.Status` 判定，不依赖宿主机 `8090`。
- 短信验证码按业务场景选择阿里云模板：登录/注册、首次绑定与换绑新号、换绑旧号验证分别对应 `CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE`、`CC_SMS_TEMPLATE_BIND_NEW_CODE`、`CC_SMS_TEMPLATE_VERIFY_BOUND_CODE`；生产 `CC_SMS_PROVIDER=aliyun` 时部署预检强制这些变量及短信凭据非空。
- 前端通过同源相对路径访问 `/api/*`；如需跨环境直连，使用 `VITE_*` 构建变量。
- 生产禁止明文 HTTP（PRD §11.2）；TLS 证书签发方式见「待确认」。

### 5.8 备份策略落地

PRD 要求（§12.3、§12.4）到落地方式的映射：

| PRD 要求 | 落地方式 |
| --- | --- |
| 数据库及上传文件每日自动备份 | Compose 内独立 backup service，cron 每日执行：对 SQLite 做一致性备份（PocketBase 备份 API 或 SQLite 在线备份，二选一以实现期验证为准）+ 打包 `pb_data` 上传文件，生成带时间戳的归档文件。每日执行的具体时间待确认 |
| 默认保留最近 30 天 | 备份脚本在每次成功后滚动清理 30 天前的归档 |
| 至少一份位于与生产服务器不同的存储位置 | 备份完成后同步到异地存储；目标存储类型与凭据下发方式待确认 |
| 每次执行结果（成功/失败）写入审计 | 备份脚本调用内部 hook 写 `audit_logs`：`action=backup`，含结果、文件名、大小、耗时、失败原因 |
| 备份失败时超级管理后台显著告警 | 超级管理端（约定 `/super/system` 及全局看板告警位）读取最近一次备份审计，失败即显示显著告警；验收按 AC-23：模拟失败后告警可见且审计有记录 |
| 恢复前二次确认并记录审计 | 恢复为运维操作而非常用功能：步骤写入部署文档（停机 → 二次确认 → 替换数据卷 → 重启校验 → 写审计）；V1 不做产品化"一键恢复"界面 |
| 恢复演练纳入上线验收 | M5 前在测试环境用最近备份完成完整恢复（机构、活动、账号、报名、签到、问卷、答卷均可找回，AC-19） |
| 镜像与数据卷分离 | SQLite 数据文件与上传文件放命名 volume；升级或重建容器只换镜像，不触碰数据卷 |

### 5.9 任务拆分（M0~M5 与本文档的映射）

| 里程碑 | 核心交付（PRD §15） | 主要落地章节 |
| --- | --- | --- |
| M0 技术骨架 | Docker、PocketBase、统一域名环境、迁移、三级账号与机构隔离原型 | §5.1、§5.2、§5.4、§5.7 |
| M1 机构与活动 | 机构、邀请码、活动、发布审核、链接/二维码、名额 | §5.3、§5.4、§5.5 |
| M2 报名与签到 | 手机号验证码登录/注册、存量账号迁移、通用登录页与"我的"中心、报名表、审核与回退、事务名额校验、固定二维码签到与补签 | §5.3、§5.4、§5.5 |
| M3 问卷 | 标准模板、有限编辑、多问卷、角色访问、草稿、提交、作废 | §5.3、§5.5 |
| M4 看板与导出 | 基础看板、指标聚合、规范化 ZIP/CSV、普通/敏感导出、审计 | §5.5、§5.6 |
| M5 生产交付 | 备份恢复与失败告警、操作手册、试点、缺陷修复、版本冻结 | §5.7、§5.8 |

里程碑退出条件以 PRD §15 原文为准，本文不重复定义；PRD 未给各里程碑的日期与负责人，禁止在实现文档中编造。

## 验收标准

本技术设计是否被正确实现，按以下对照验收（最终业务验收以 PRD §14 的 AC-01~23 原文为准）：

| 技术验收点 | 对应依据 | 验证方式 |
| --- | --- | --- |
| 一套 Compose 在本地与测试服务器一键启动，三端与数据库正常 | M0 退出条件、AC-01 | `docker compose up` 后访问三端入口 |
| 机构隔离：跨机构 ID/筛选/URL/API 参数/导出均无权访问 | FR-ORG-006、AC-03 | 自动化越权测试全部通过 |
| 手机号创建与存量登录：新手机号验证后创建且重试不重号；未知用户名与错误密码均不建号、不签发 token；用户名规则生效 | 专项 PRD §3、AC-06 | 接口测试 |
| 连续登录失败触发临时限制 | FR-AUTH-007、AC-21 | 接口测试（阈值待定项确认后固化） |
| 名额硬限制：满额禁止通过、名额不可低于已通过数、两名管理员并发审核不超额 | FR-ACT-006/007、AC-08 | 并发接口测试 |
| 状态回退重新执行名额校验且全程留痕；矩阵外迁移被拒绝 | §4.4、AC-07 | 接口测试 + 审计记录核对 |
| 签到：仅已通过者在开放期可签、一人一签、补签/撤销有审计 | FR-CHK-*、AC-09/10 | 接口测试 |
| 报名/签到/问卷重复提交不产生重复正式记录 | §13、AC-20 | 网络重试/重复点击模拟 |
| 导出：范围服务端校验、敏感开关生效、ZIP 内含 manifest 与 data_dictionary、按 `is_sensitive` 过滤 | FR-EXP-*、AC-16/17 | 导出包内容检查 |
| 看板新增指标不重构页面与数据表；指标口径与导出一致 | FR-DASH-002/005、M4 退出条件 | 代码评审 + 数据核对 |
| schema 全部经 `pb_migrations` 版本化；业务集合无删除入口 | §13、AC-18 | 迁移文件评审 + API 删除测试 |
| 备份：测试环境完整恢复成功；模拟失败后超级管理后台可见告警且审计有记录 | §12.3、AC-19/23 | 恢复演练 + 故障注入 |

## 待确认

以下信息 PRD v0.3 与已确认技术决策均未给出，实现前需取得对应证据；标注"不阻塞"的项可先按本文档约定推进能力层建设。

| # | 事项 | 缺少的证据/决策 | 对实现的影响 |
| --- | --- | --- | --- |
| 1 | 登录限流的阈值与锁定时长 | PRD 仅规定"达到阈值后临时限制"（FR-AUTH-007），无数值 | 认证端点参数；建议实现为可配置常量，验收 AC-21 前必须定值 |
| 2 | 管理后台与超级管理员的 token 过期时长 | PRD §12.4 仅要求"具备令牌过期和主动退出机制" | 会话配置 |
| 3 | 管理员用户名规则 | PRD 只定义了参与者用户名规则（4–20 位、字母/数字/下划线、大小写不敏感唯一） | `admin_accounts` 校验逻辑；未确认前建议暂套用同一规则 |
| 5 | 标准问卷模板完整题目与锁定题清单 | PRD §16.2"待模板确认" | **不阻塞**模板版本化结构（`survey_template_versions` 不可变 + `locked` 标记）；阻塞模板初始化数据 |
| 6 | 邀请码明文形态（长度、字符集） | PRD 只规定 `token_hash` 存储与默认 7 天有效期 | 邀请码生成与输入 UI |
| 7 | 备份每日执行时间 | PRD 仅"每日自动备份" | 备份 cron 配置 |
| 8 | 异地备份的目标存储类型与凭据下发方式 | PRD 仅要求"至少有一份位于与生产服务器不同的存储位置" | 备份同步实现与 secrets 管理；阻塞 AC-19/23 的完整落地 |
| 9 | 反向代理选型（Nginx / Caddy / Traefik 等）与 TLS 证书签发方式 | PRD 仅规定"反向代理与 HTTPS" | `deploy/` 配置；阻塞 AC-01 生产可访问 |
| 10 | staging 环境入口（独立子域名或端口） | PRD 只定义正式域名 `chatcircle.empact.cn` | 环境配置与测试脚本 |
| 11 | PocketBase 升级策略 | 当前已锁定 0.28.4 且 T0 探针基于该版本；尚无长期升级频率/回归规则 | 升级前需重跑 migration/hook/auth/realtime 全套验证，不阻塞 T1–T6 |
| 12 | 前端辅助库选型（数据请求/状态管理、UI 组件库、二维码生成、测试框架） | PRD 仅确认 React 18 + Vite + TypeScript | 依赖清单；M0 选型后应回写本文档或决策记录 |
| 13 | 超级管理员初始凭据的生成、下发与保管流程 | PRD 只规定"初始部署时创建、全平台仅一个" | 上线 checklist；凭据不得入库入文档 |
| 14 | 导出文件存储目录与磁盘容量监控阈值 | PRD 规定文件不自动失效，长期治理由后续政策决定 | 运维监控；不阻塞导出功能本身 |
| 16 | CI/CD 当前策略与必过检查是否符合最新团队要求 | 仓库与 `.github/workflows/` 已存在，但本文未在本次规划任务中查询远端 required checks | 不阻塞专项设计；发布前需以 GitHub 当前设置复核 |
| 17 | 是否引入从 schema 生成前端共享类型的工具 | 无证据 | `src/shared/` 类型与 `pb_migrations` 的同步方式；未确认前手工同步 |
| 18 | SMTP 发信邮箱凭据的下发与配置责任（2026-08 后端改版） | 已确认走 PB Settings 手工配置、凭据不入库，用户方已有可用发信邮箱；但由谁在生产控制台配置、凭据如何安全下发未定 | 阻塞 AC-24 邮件真实投递的上线验收；不阻塞能力层开发（测试环境不配 SMTP，端点可用但仅记录不发信） |
| 19 | 验证/找回邮件模板与前端路由 | 已实现：迁移设置 `/admin/verify-email#token={TOKEN}`、`/admin/reset-password#token={TOKEN}`，页面主动确认且移除 fragment | SMTP、APP_URL 和真实邮件端到端验收仍待服务器配置，见 [运营手册](../privacy-operations.md) |
