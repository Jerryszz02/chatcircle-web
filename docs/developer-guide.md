# Chat Circles 开发者指南

> **这份文档是什么**：写给第一次接触本项目的开发者。读完后你应该能：
>
> 1. 说清楚系统每一块逻辑在哪里、怎么运转；
> 2. 独立完成常见修改（加字段、加接口、加页面、改业务规则），并知道要补哪些测试、会踩哪些坑。
>
> **这份文档不是什么**：它不是设计文档。`docs/planning/` 下的文档（技术设计、数据库设计、测试计划、安全隐私、UI 设计）是开发前编写的**设计与需求基线**，描述"当初打算怎么建"；本文描述**代码现状**——"系统现在实际是怎么实现的、怎么改"。两边不一致时以代码为准，并请顺手修正本文。需求口径的权威来源仍是 `docs/` 下的 PRD v0.3 docx。
>
> 各子目录另有聚焦手册，本文会引用而不是复制它们：`backend/README.md`（后端操作）、`deploy/README.md`（生产部署）、`mcp/README.md`（MCP 数据取送）、`e2e/`（端到端测试）。
>
> **专项升级边界（2026-09-02）**：T0–T6 已在默认分支实现。T7 增加双角色签到/配对/Realtime/细粒度导出全链路 E2E、无密钥发布配置检查和统一发布验收入口；自动化已通过，生产放行仍按 [`release-checklist.md`](release-checklist.md) 执行。

---

## 1. 项目一页纸

**Chat Circles** 是 Empact 统一运营的**多机构活动管理 / 报名审核 / 签到 / 问卷 / 聆听者培训平台**。它把公益心理陪伴活动的报名、签到、问卷从微信群和零散表格搬到统一网站上。正式域名 `chatcircle.empact.cn`。

核心业务闭环（一条数据的完整生命周期）：

```
机构建活动(发布/审批) → 参与者报名 → 机构人工审核 → 现场扫固定二维码签到 → 活动后填问卷 → 机构/平台看板与导出 → 外部 agent 出报告回传
```

三类用户角色（注意与"活动内角色"区分）：

| 角色 | 后端身份 | 数据范围 |
|---|---|---|
| 超级管理员（全平台唯一） | PocketBase `_superusers` | 全平台 |
| 机构管理员 | `admin_accounts`（auth 集合，带 `organization_id`） | 仅本机构 |
| 参与者 | `participant_accounts`（auth 集合，不绑机构；已验证手机号为主要登录身份） | 仅本人 |

「倾诉者 speaker / 聆听者 listener」**不是平台角色**，而是每条报名记录上的 `activity_role`；同一参与者可在不同活动选不同角色。聆听者培训是与活动解绑的独立体系：签到资格 = 该账号在全平台任一活动有 approved 的 listener 报名。

技术形态一句话：**React 18 + Vite + TypeScript 单 SPA（手机优先，按角色分 `/`、`/admin`、`/super` 三区）+ PocketBase 0.28.4（认证 / API rules / pb_hooks 业务规则 / SQLite）+ Docker Compose 一体化部署（前端产物由 PocketBase 从 `pb_public/` 同源伺服）**。

## 2. 仓库地图

```
├── frontend/            # React SPA。src/features/{participant,admin,superadmin} + src/shared/
│                        #   详见 frontend 各节；操作手册级内容不在这里，全在本文 §6
├── backend/             # PocketBase 后端
│   ├── pb_migrations/   #   版本化 schema（28 个迁移文件 / 26 个业务或内部集合），schema 变更的唯一入口
│   ├── pb_hooks/        #   服务端业务规则（JSVM *.pb.js）：54 个自定义路由 + Realtime 守卫 + 写守卫 + 审计
│   ├── tests/           #   L3 集成套件 + 迁移冒烟（CI 必过），仅用 bash/curl/python3 标准库
│   ├── scripts/         #   种子数据、历史数据补录
│   ├── pb_data/         #   本地开发数据（SQLite），【不入库】
│   ├── pb_public/       #   前端产物放置处，PocketBase 同源伺服，【不入库】
│   └── pocketbase       #   二进制需手工下载，【不入库】
├── mcp/                 # 给数据分析 agent 用的 MCP server（取数走导出 API、报告回传 reports 集合）
├── e2e/                 # Playwright 主链路端到端测试（L4）
├── deploy/              # backup.sh 每日备份、Caddy 反代配置、生产部署手册
├── docs/
│   ├── developer-guide.md      # 本文：代码现状与修改指南
│   ├── planning/               # 设计与需求基线文档（非现状描述），索引见 planning/README.md
│   └── security-hardening-2026-08.md  # 2026-08 安全加固专项记录
├── .github/workflows/   # ci.yml（PR 必过）/ deploy.yml（推 main 自动部署）/ e2e.yml
├── Dockerfile           # 多阶段：前端 build → PocketBase 运行时（一体化镜像）
├── docker-compose.yml   # app + backup + caddy 三服务
└── .env.example         # 全部环境变量（真实 .env 与 secrets 不入库）
```

## 3. 本地开发环境

前置：**Node 22+**、**python3**（后端测试与种子脚本，仅用标准库）、PocketBase 二进制（版本锁定 **0.28.4**，下载与校验见 `backend/README.md`；测试脚本缺失时会自动下载）。

```sh
# 后端（终端 1）——三个目录参数必须显式传，否则 hooks 不生效 / 用错数据目录
cd backend
./pocketbase migrate up --dir pb_data --migrationsDir pb_migrations --hooksDir pb_hooks
./pocketbase superuser create admin@cc.local '换成你自己的强密码' --dir pb_data   # 首次
bash scripts/seed_demo.sh    # 可选：幂等演示种子（机构/管理员/活动/问卷/参与者，见输出末尾的邀请码）
./pocketbase serve --dir pb_data --migrationsDir pb_migrations --hooksDir pb_hooks
# 健康检查 http://127.0.0.1:8090/api/cc/health → {"ok":true}；PB 管理台 http://127.0.0.1:8090/_/

# 前端（终端 2）——dev server 把 /api 代理到 127.0.0.1:8090（可用 VITE_PB_URL 覆盖）
cd frontend
npm install
npm run dev
```

Docker 一键启动（生产同构）：`cp .env.example .env` → **先填好 `.env`** → `docker compose up --build`。注意 compose 对五个变量用了 `${VAR:?}` 必填校验，而 `.env.example` 里它们默认注释掉，不填会在启动前的变量插值阶段直接报错：`CC_PHONE_HASH_KEY`（手机号 HMAC 密钥）、`PB_SUPERUSER_EMAIL` / `PB_SUPERUSER_PASSWORD`（backup 服务登录用超管）、`ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET`（caddy 的 DNS-01 证书签发）。本地只是想跑起来看看时可用占位值填上（backup 登录、caddy 证书签发失败属预期），但**生产基础 compose 默认不向 host 发布 app 的 `8090`**——要本机直连调试，需显式叠加 `docker compose -f docker-compose.yml -f deploy/docker-compose.debug.yml up -d` 发布回环 `127.0.0.1:8090`（该 override 存在「本地伪造 XFF」风险，见 deploy/README.md §5，仅限知悉下使用）。日常本地开发更推荐上面的原生启动方式。

常用端口约定：开发后端 8090 / 种子脚本临时实例 8096 / 集成测试 8097 / 迁移冒烟 8099 / e2e 18090+14173。

## 4. 架构总览：先建立这五个心智模型

1. **写入收口**。几乎所有业务写操作（报名、审核、签到、问卷、导出、邀请码……）都只走 `pb_hooks` 里的自定义端点（`POST /api/cc/*`），在服务端事务内完成；集合的直连 create/update 被 `guards.pb.js` 等守卫封堵，直连 delete 全部集合关闭。前端集合 API 主要用于**读**。
2. **读路径分两路**。管理端读集合走 PocketBase 原生 API + API rules（机构隔离靠 rule 里的 `@request.auth.organization_id` 链式反查）；参与者读公开/聚合信息走 hooks 白名单端点（`/api/cc/public/*`、`/api/cc/me/*`），不直连集合。
3. **机构隔离在服务端强制**。写路径分两种：**自定义端点**内 `organization_id` 一律由 hooks 从登录身份注入，客户端传入的会被忽略；少数放行的**集合直连 create**（活动、培训、机构自定义报名字段）则由前端显式传本机构 `organization_id`（取自登录管理员身份，如 `ActivityForm.tsx`），由 API rules 校验 `@request.auth.organization_id = organization_id`，且 guards 禁止 update 再改它。读路径靠 rules 按身份过滤。跨机构访问返回 **404 而非 403**（不泄露资源存在性）。
4. **无硬删除**。全部 26 个业务/内部集合 `deleteRule: null`；停用/归档/作废/撤销/释放一律用状态字段表达（FR-AUD-001）。改代码时不要引入任何删除语义。
5. **pb_hooks 是隔离作用域的 JS，不是 Node 项目**。PocketBase 0.28 JSVM 中各 `*.pb.js` 文件作用域完全隔离，没有 import/全局共享。`pb_hooks/lib/` 下三个文件（http/ratelimit/audit）是**契约标准源，运行时不会被加载**；每个领域文件把所需工具函数**原样内联**在自己闭包里。**改 lib 语义后必须同步所有内联副本**——这是本仓库最大的维护陷阱（文件头部有"勿手工改副本"警告）。

整体请求路径（生产）：浏览器 → Caddy（TLS、安全头、封 `/_/*`）→ PocketBase（`pb_public/` 静态前端 + 集合 API + `/api/cc/*` hooks）→ SQLite。

## 5. 后端详解

### 5.1 数据模型（26 个业务/内部集合）

schema 定义全部在 `backend/pb_migrations/`，一个迁移文件建一个域（命名 `<Unix时间戳>_cc_<域名>.js`，按时间戳排序执行）。按域分组：

**账号与机构**

| 集合 | 用途与关键字段 |
|---|---|
| `organizations` | 机构主数据 + 机构级开关：`status`(active/disabled)、`require_activity_approval`（活动发布需平台审核）、`allow_sensitive_export`（敏感导出开关） |
| `admin_accounts` (auth) | 机构管理员：username+密码、`organization_id`、`status`；`authRule: status='active'` 拒绝停用账号登录；token 7 天 |
| `admin_invites` | 一次性管理员邀请码：**只存 `token_hash`**（sha256），明文仅生成时返回一次；`status`(unused/used/revoked/expired)、`expires_at`（默认 7 天） |
| `participant_accounts` (auth) | 参与者：已验证手机号为主要身份；完整 `phone_e164` 与 HMAC 查找值为 hidden，公开响应仅给掩码/绑定状态；username+密码只保留给存量迁移；token 30 天 |
| `participant_phone_challenges` | 手机验证码内部 challenge：只存手机号 HMAC、用途、账号关系、provider/状态/过期时间，不存完整手机号或验证码；全部集合 API rules 关闭 |

**活动与报名**

| 集合 | 用途与关键字段 |
|---|---|
| `activities` | 活动：除生命周期、名额、报名与签到 token 外，T2 增加 `pairing_started_at/by`、`onsite_locked_at/by` 与两侧下一个现场序号计数器；现场内部字段只能由服务端事务修改 |
| `activity_approvals` | 发布审核历史，只追加不可变：`action`(submit/approve/reject)、`reason`（驳回必填） |
| `registration_field_defs` | 报名字段定义库：`organization_id=''` 表平台标准字段（仅超管维护），非空为机构自定义；`field_code`、`field_type`(text/number/single_choice/multi_choice/date)、`is_sensitive`（**导出过滤的唯一依据**）、`role_scope`(both/speaker/listener，分角色报名表单)；复合唯一 (organization_id, field_code) |
| `registrations` | 报名：`activity_role`(speaker/listener)、`status`（4 态）；复合唯一 (activity_id, participant_id)＝一人一活动一报名；**无冗余 organization_id**，经 `activity_id.organization_id` 反查隔离 |
| `registration_answers` | 报名答案 `value_json`，写入后只读；复合唯一 (registration_id, field_def_id) |

**签到**

| 集合 | 用途与关键字段 |
|---|---|
| `checkin_sessions` | 签到开放窗口："未开放"不建行，每次开放新建一行、关闭置 `closed`；"同时至多一条 open"由 hooks 事务保证（SQLite 无法部分唯一） |
| `checkins` | 签到记录：撤销保留原行；T2 在创建 valid 签到的同一事务中写 `onsite_role/onsite_sequence/numbered_at` 并递增活动角色计数器，撤销后号码不复用、存量签到不补号 |
| `activity_pairs` | T2 配对记录：活动内单调递增 `pair_sequence`，双方 registration/checkin，`active/released/completed` 状态与调整/释放留痕；参与者不能直读，写入全部走配对 hooks |

**问卷**

| 集合 | 用途与关键字段 |
|---|---|
| `survey_templates` + `survey_template_versions` | 标准模板 + 不可变版本快照。两集合**循环引用**（`current_version_id ↔ template_id`），迁移分三步建；版本发布后 update/delete 全禁，模板升级 = 新增版本 + 移动 current 指针；`schema_json` 存题目完整定义 |
| `activity_surveys` | 活动问卷：从模板版本**物化复制**创建，创建后不随模板升级；`survey_code`/`qr_token` 唯一、`role_scope`、`status`（5 态） |
| `survey_questions` | 问卷题目（schema_json 物化为行）：`question_code`（稳定机器码）、`question_type`（7 种：info/single_choice/multi_choice/scale_1_5/scale_0_10/text_short/text_long）、`locked`（核心锁定题机构不可改删）、`is_sensitive`；复合唯一 (activity_survey_id, question_code) |
| `submissions` | 答卷：一人一问卷一份（草稿→提交是**同行状态变更**）；`status`(draft/submitted/voided)；复合唯一 (activity_survey_id, participant_id)；完成数口径 = submitted 计数，**导出与统计一律排除 voided** |
| `answers` | 题目答案：`question_code` **冗余存储**（导出直接关联，历史答案不受题目调整影响）；复合唯一 (submission_id, question_code) |

**导出 / 审计 / 报告**

| 集合 | 用途与关键字段 |
|---|---|
| `export_jobs` | 导出任务：`organization_id=''` 表超管全平台导出；`scope_json`、`include_pii`（敏感导出标记，需机构开关+二次确认+审计）、`file_path`（受保护目录）、`status`(running/done/failed) |
| `audit_logs` | 不可变审计：仅服务端 `writeAudit()` 写入，update/delete 全关；`actor_id`（系统任务用 `'system'`）、`actor_role`、`action`（如 `registration.approve`、`backup.failed`）、`result`、`metadata`（**不得含密码/完整敏感答案**） |
| `reports` | 数据分析报告（外部 agent 经 MCP 上传）：`file` 为 protected 文件（URL 须带 token）、`status`(draft/published，agent 上传强制 draft)；rules 全 null＝仅超管 |

**聆听者培训**（2026-08 扩展，与活动解绑、镜像签到三件套）

| 集合 | 用途 |
|---|---|
| `trainings` / `training_checkin_sessions` / `training_attendances` | 培训主数据 / 签到窗口 / 签到记录，结构与活动签到同构；`trainings.status` 仅 3 态；"培训通过"账号级口径 = 存在任一 valid attendances 记录 |

### 5.2 API rules 控权模型

- `_superusers` 天然绕过所有 rules；平台级集合（organizations、admin_invites、survey_templates/versions、reports）rules 全 `null`＝仅超管。
- 机构管理员：统一靠 `@request.auth.organization_id = <本行机构>`；多级子表链式反查（如 `answers` 用 `submission_id.activity_survey_id.activity_id.organization_id` 三级）。
- 放行的直连 create（activities、trainings、registration_field_defs 的机构自定义部分）：客户端传 `organization_id`，createRule 校验 `@request.auth.organization_id = organization_id`；因此新增同类直连创建流程时**必须传本机构值**，漏传会因校验失败被拒。
- 凡 `organization_id` 可空的集合，rule 首段加 `@request.auth.organization_id != ''`，防止参与者/匿名命中 `''=''` 读到平台级记录。
- 参与者：仅 list/view 本人记录；create 大多锁死或限本人且初始状态固定；提交后不可改。
- 未认证 list 非空 rule 的集合返回**空集**而非 403（rule 为 null 才 401/403）——排查权限问题时先分清这两种形态。

### 5.3 状态机全集

**活动 `activities.status`（7 态）**：`draft → published → closed → archived`；机构开了发布审核时 `draft → pending_review → published`（超管 approve/reject，reject 可改后重提）；`published → taken_down`（仅超管下架）。对已 taken_down/archived 活动拒绝报名审核。

**报名 `registrations.status`（4 态，无候补）**：迁移走 `POST /api/cc/registrations/{id}/transition`，白名单矩阵（`registrations.pb.js` 的 `CC_REGISTRATION_TRANSITIONS`，矩阵外一律 `ILLEGAL_TRANSITION`）：

| 迁移 | 动作代码 | 说明 |
|---|---|---|
| pending→approved | `registration.approve` | 事务内名额硬校验 |
| pending→rejected | `registration.reject` | |
| approved→cancelled | `registration.cancel` | reason 必填 |
| rejected/cancelled→approved | `registration.status_revert` | reason 必填，重校验名额 |

同态请求幂等返回；审核通过时可一并改 `activity_role`（另记 `registration.role_change` 审计）。

**签到**：`checkins.status` = valid/revoked；前置 = 报名 approved 且有 open 场次。区分 `checkin_not_open`（从未开放）与 `checkin_closed`（曾开后关）。

**活动问卷 `activity_surveys.status`（5 态）**：`draft/not_open → open → ended`（+archived）；开放/结束由管理员手动控制。参与者填写资格**四条件**：登录 + 报名 approved + 角色匹配 role_scope + 问卷 open（明确不强制已签到）。

**答卷 `submissions.status`（3 态）**：draft→submitted 同行变更、提交即锁定、submit 幂等；作废仅 submitted→voided（管理员、reason 必填、审计），V1 不支持作废后重填。

**培训 `trainings.status`（3 态）**：draft→published→closed；培训签到资格 = 全平台任一 approved listener 报名（否则 `listener_not_approved`）。

### 5.4 自定义端点全集（55 个 `routerAdd`，统一 `/api/cc/*` 前缀）

鉴权标记：`anon` 无需登录 / `participant` / `admin`（机构管理员，requireAuth 同时校验账号与所属机构均 active）/ `super` / `admin|super`。

**健康与认证**（`main.pb.js`、`auth.pb.js`、`authguard.pb.js`）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| GET `/api/cc/health` | anon | 存活探针 |
| POST `/api/cc/auth/participant` | anon | **仅存量用户名账号迁移登录**：用户名小写归一，只校验已存在账号；未知用户名与错误密码同形拒绝且不建号、不签发 token；双层限流（同人+IP 5 次/10min、同 IP 跨用户名 30 次/10min 防喷洒） |
| POST `/api/cc/auth/participant/request-code` `/verify-code` | anon | 手机号验证码请求与登录/注册；响应不区分号码是否已注册，成功响应不含内部 username/完整手机号/HMAC |
| POST `/api/cc/auth/participant/bind-phone` `/change-phone` | participant | 存量账号绑定保留 participant_id；换绑需旧号和新号双验证码，冲突不自动覆盖 |
| POST `/api/cc/auth/admin-register` | anon | 一次性邀请码注册管理员（邀请码 + 用户名 + 必填邮箱 + 密码），事务内消费邀请码+建号+审计 |
| （非路由）PB 内置 auth-with-password | — | `authguard.pb.js` 补限流：per-IP 20 次/10min + per-身份+IP 5 次失败/10min |

**活动生命周期**（`activities.pb.js`，另挂模型钩子：创建时强制 `checkin_qr_token = 24 位随机串`、名额不变量校验）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| GET `/api/cc/public/activities` `/{id}` | anon | 活动广场/公开详情（仅 published/closed，其余 404），含报名开放状态与剩余名额；列表支持 `?scope=current`（未结束）/`past`（已结束或已关闭）服务端过滤，报名开放判定含活动 `end_time`（已结束即截止，reason=ended） |
| POST `/api/cc/activities/{id}/submit-review` | admin | draft/rejected → pending_review |
| POST `/api/cc/activities/{id}/publish` `/close` `/archive` | admin | 直发（机构开审核则拒绝）/ 关闭 / 归档 |
| POST `/api/cc/activities/{id}/duplicate` | admin | T4 复制活动：配置与问卷/题目物化行复制为新草稿，活动代码、签到 token、问卷入口 token 重新生成，历史报名/签到/配对/答卷/审计不复制；写 `activity.duplicate` 审计 |
| POST `/api/cc/activities/{id}/approve` `/reject` `/unpublish` | super | 审批 / 驳回（reason 必填）/ 下架（不走 approvals） |

**报名**（`registrations.pb.js`）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| POST `/api/cc/activities/{id}/register` | participant | 幂等（同人同活动返回现有）、开放窗口校验、名额预检、role_scope 答案校验，事务建 registrations+answers |
| POST `/api/cc/registrations/{id}/transition` | admin | 状态机迁移（矩阵见 §5.3），事务内名额硬校验 `ccAssertCapacity`，重读防并发漂移（409） |

**签到**（`checkins.pb.js`；培训镜像在 `trainings.pb.js`，路径把 checkin 换成 training 对应形态）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| POST `/api/cc/activities/{id}/checkin/open` `/close` | admin | 开放/关闭签到场次，单 open 约束，幂等 |
| POST `/api/cc/checkin/self` | participant | 扫码自助签到：按 `checkin_qr_token` 定位活动；校验链=登录→活动状态→事务内（报名 approved→已有 valid 幂等返回→有 open 场次） |
| POST `/api/cc/checkins/manual` | admin | 补签（reason 必填+审计） |
| GET `/api/cc/activities/{id}/checkin/manual-candidates` | admin | 补签候选人名单（服务端注入本活动已通过报名者） |
| POST `/api/cc/checkins/{id}/revoke` | admin | 撤销（只改状态不删行，reason 必填+审计） |
| POST `/api/cc/trainings/{id}/publish` `/close`、`/checkin/open` `/close` | admin | 培训生命周期与签到场次 |
| POST `/api/cc/training-checkin/self` | participant | 培训自助签到（资格=全平台任一 approved listener 报名） |
| POST `/api/cc/training-checkins/manual`、`GET /api/cc/trainings/{id}/checkin/manual-candidates`、`POST /api/cc/training-checkins/{id}/revoke` | admin | 培训补签/候选人/撤销 |
| GET `/api/cc/me/trainings` | participant | 培训页聚合：{eligible, trained, trainings[]}，不下发 qr token |

**现场编号与配对**（`pairings.pb.js`）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| POST `/api/cc/activities/{id}/pairings/start` | admin\|super | 首次记录开始事实并按两侧现场序号批量配对；重复调用只补等待队列，不重排旧组 |
| POST `/api/cc/activities/{id}/pairings/reassign` | admin\|super | 原子释放涉及的 active pair 并建立指定新组；reason 必填，同一目标重复调用幂等 |
| GET `/api/cc/activities/{id}/my-pairing` | participant | 只返本人现场号/组号/搭档现场号与该场 `FULL_NAME`，不暴露 pair record 或手机号 |
| POST `/api/cc/activities/{id}/onsite/lock` | admin\|super | 幂等锁定“活动已开始”事实；锁定后撤销只释放，后续改组须人工调整 |

**问卷与答卷**（`surveys.pb.js`、`submissions.pb.js`）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| POST `/api/cc/activities/{id}/surveys` | admin | 从模板版本复制建卷，题目物化到 survey_questions |
| POST `/api/cc/activity-surveys/{id}/open` `/close` | admin | 开放/结束问卷 |
| GET `/api/cc/surveys/{qrToken}` | participant | 问卷元信息+四条件资格结果+题目（资格过或本人有答卷才下发）+本人答案预填 |
| POST `/api/cc/activity-surveys/{id}/draft` `/submit` | participant | 草稿同行 upsert；提交=必填校验+锁定+幂等 |
| GET `/api/cc/submissions/{id}` | participant | 本人答卷只读（participant_id 强校验） |
| POST `/api/cc/submissions/{id}/void` | admin | 作废（reason 必填+审计） |
| GET `/api/cc/me/overview` | participant | 「我的」聚合：报名+可填问卷+已提交答卷+listener 资格标记 |

**导出、看板与单活动实时数据**（`exports.pb.js`、`metrics.pb.js`、`live.pb.js`）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| POST `/api/cc/exports/preview` | admin\|super | T6 v2 预览：归一化范围/行列、预估数据域行数、服务端判敏与权限结果；不返回实际数据 |
| POST `/api/cc/exports` | admin\|super | v2 生成 XLSX/CSV ZIP，create 重算判敏并写 job/审计；旧 v1 形状归一化后保留固定 13 CSV 兼容一个发布窗口 |
| GET `/api/cc/exports/{id}/download` | admin\|super | 鉴权下载 XLSX/ZIP（admin 仅本机构 job），记 export.download 审计 |
| GET `/api/cc/metrics/{metricKey}` | admin\|super | 看板指标，8 个 key 注册表分发（口径注释在文件头，改口径前先读） |
| GET `/api/cc/activities/{id}/live-summary` | admin\|super | T3 单活动同快照汇总：报名、签到、配对、问卷、匿名人口统计与最近签到；机构管理员仅本机构，跨机构 404 |

**超管**（`super.pb.js`）

| 端点 | 说明 |
|---|---|
| POST `/api/cc/super/invites`、`POST /api/cc/super/invites/{id}/revoke` | 邀请码生成（`cc_inv_`+24 随机，只存 sha256，明文仅本次响应）/ 撤销 |
| GET `/api/cc/super/backup-status` | 最近备份审计 + 三态告警（无记录/失败/超 36h 视为 cron 中断） |
| POST `/api/cc/super/backup/run` | **已下线，恒 410**（真备份走 deploy/backup.sh + PB 自带 `/api/backups`） |
| POST `/api/cc/super/templates`、`POST /api/cc/super/templates/{id}/publish` | 问卷模板创建（事务解循环引用）/ 发新版本（已发布版本不可变） |

**直连写守卫**（`guards.pb.js` + surveys/submissions/reports 内模型钩子）：activities/trainings 创建强制 draft、禁改 status/organization_id/checkin_qr_token；registrations/answers/checkins/sessions/attendances 禁直连写；accounts 禁改 status/org；survey_questions 的 locked 题禁改、question_code 不可变；reports 创建强制归因+审计。所有守卫对 `_superusers` 放行（运维/测试）。

### 5.5 横切机制

- **审计**：`writeAudit(app, entry)`，约定与业务写**同事务**（事务内传 txApp）。动作代码分布见各域文件；改业务动作时别忘了补审计。
- **限流**：滑动窗口，状态存 `$app.store()`（Go 侧共享 KV，**单实例部署前提**），键前缀 `cc_rl|`。生产经 Caddy 反代必须启用 trusted proxy headers（迁移 `1785889200` 已设 `X-Forwarded-For`），否则 per-IP 限流退化为全平台共享桶。
- **敏感导出过滤**：普通导出按 `registration_field_defs.is_sensitive` 与 `survey_questions.is_sensitive` 两个标记位排除（**禁止按字段名启发式判断**），participants.csv 不含 username；敏感导出需机构开关 + `confirm:true` 二次确认 + 独立审计动作。CSV 公式注入防护（`= + - @ Tab` 前置单引号）。导出文件落 `pb_data/exports`（0700/0600），文件名随机，下载有路径前缀防护。
- **名额并发**：报名创建端点只是预检，**硬校验在 transition 到 approved 的事务内**（总名额+角色名额双查）；SQLite busy 类错误重试 2 次后 409。
- **错误形态**：统一 `{code, message, data:{code}}`；handler 抛 `ccError` 由顶层 catch 转换，事务内抛出即回滚。部分文件（surveys/submissions/exports/super/metrics）混用 `jsonError` 直接 return 形态——改代码时跟随本文件既有风格。
- **Realtime 只做失效通知**：管理端订阅 activities/registrations/checkins/activity_surveys/submissions/activity_pairs 后统一防抖重取 `live-summary`，不从事件 payload 推导指标；参与者只能订阅自己的 `cc.participant.pairing.<participantId>` 主题，且消息发送前再次按当前认证清洗。人口统计任一桶小于 5 时，该维度全部桶一起抑制，防止结合已通过总数做减法反推。
- **配置**：hooks 内**没有任何环境变量**，阈值都是代码内常量（登录 5 次/10min、邀请码默认 7 天、签到 token 24 位……）。运行时持久状态只有 `$app.store()` 和 `pb_data/exports`。

### 5.6 迁移编写约定

- 结构 `migrate((app) => {up}, (app) => {down})`，**down 必须真实可回滚**（冒烟脚本做 up→down→up 往返验证）。
- PocketBase 0.28 **不自动附加 `created`/`updated`**：每个集合显式声明两个 autodate 字段。
- `bool` 一律 `required: false`（0.28 中 required bool 会强制取 true）。
- 空 relation 存 `''` 而非 NULL（"平台级 vs 机构级"用 `organization_id = ''` 表达，空串可参与唯一索引）。
- relation 一律 `cascadeDelete: false`（配合无硬删除）。
- SQLite 无法表达"部分唯一"（如"每活动至多一条 open 会话"）：**不建全量唯一索引，由 hooks 事务保证**。
- 注意 `migrate` 失败退出码也可能为 0：脚本都要 grep 输出中的 `Error`（测试脚本已这么处理）。

### 5.7 后端测试体系（`backend/tests/`）

- `run_integration.sh`（L3 集成套件，**CI 必过**）：自举临时实例（mktemp 目录，不污染本地 pb_data）→ 空库 migrate → 建临时超管 → SQL 直插模板 fixture → 跑 `integration/` 下 22 个 suite（当前 601 断言）：越权矩阵、名额/配对并发、状态机、手机号认证、Realtime ACL、复制活动、问卷资格、v1/v2 导出准确性与敏感门禁、限流、备份告警、无硬删除和安全加固等。
- `migration_smoke.sh`：seed 及后续迁移局部回滚 → 全量 down → sqlite3 直查 26 个业务/内部集合清零 → 再 up，随后 serve 抽查，共 62 项。
- **两条强制规则**：① authguard 对内置 auth-with-password 按 IP 限 25 次/10min，一轮全量当前使用 22 次（余量 3）——新增套件仍应避免消耗这项预算，管理员登录态用 impersonate，参与者走 `/api/cc/auth/participant`；② 新增带 `organization_id` 的接口，**必须同 PR 补机构越权用例**（通用端点放 `suite_acl.py`，领域聚合端点可放对应 suite）。

## 6. 前端详解（`frontend/`）

### 6.1 技术选型

极简依赖：react/react-dom 18、react-router-dom 6、pocketbase SDK 0.21（既是 HTTP client 也是 auth 存储）、qrcode（管理端本地生成二维码 dataURL）。**没有**状态库、UI 库、CSS 框架、图表库（看板是纯数字卡片）。状态管理 = useState/useEffect + PB authStore 订阅。构建脚本 `build = tsc --noEmit && vite build`（先类型检查）。

### 6.2 目录与分层

```
src/
├── router.tsx             # 全应用唯一路由表（+ router.test.tsx 守卫测试）
├── shared/                # 跨三端共享层
│   ├── pocketbase.ts      #   3 个按角色隔离的 PB client 单例（见 §6.3）
│   ├── auth.ts / session.ts / guards.tsx
│   ├── api/               #   types.ts（当前 record 类型+枚举，与 pb_migrations 手工同步）
│   │                      #   accountEvent.ts（T0 冻结契约；T1–T6 已实现）
│   │                      #   collections.ts（类型化 RecordService 封装）、http.ts（自定义端点 fetch 包装）
│   ├── ui/                #   无样式结构组件（Button/Card/Modal/Toast/Loading/PageLayout/ForbiddenPage…）
│   ├── styles/global.css  #   设计 token + .cc-* 共享类（见 §6.6）
│   ├── metrics/           #   看板指标注册表（与后端 metrics.pb.js 对应）
│   ├── survey/            #   问卷题目编辑器草稿模型（admin/superadmin 共用）
│   └── lib/datetime.ts    #   PB UTC 日期解析、本地日→UTC 边界换算
├── features/{participant,admin,superadmin}/
│   ├── pages.tsx          #   barrel，同时负责 import 本端 CSS
│   ├── pages/  components/  lib/   # 页面 / 本端组件 / 纯函数领域逻辑（测试主要打 lib）
│   └── api.ts(或 lib/api.ts)       # 自定义端点封装；admin/lib/activityLive.ts 负责 T3 Realtime 失效订阅与重取，
│                                   #   participant/lib/myPairingLive.ts 负责 T5 本人配对状态的失效订阅与重取
└── test/                  # vitest setup + mockApi.ts（fetch stub 工具）
```

### 6.3 认证模型与路由守卫

- **三角色各一个 PB client 单例**，token 分 key 存 localStorage（`cc_participant_auth`/`cc_admin_auth`/`cc_super_auth`）；任一角色登录成功会**清空另两角色会话**（单会话互斥）。角色→集合映射：participant→participant_accounts、admin→admin_accounts、super→_superusers。
- PB 地址：`VITE_PB_URL` 或回退 `window.location.origin`（生产同源）。client 关闭了 autoCancellation，并包了两层：stripUndefinedParams（SDK 0.21 会把 `filter: undefined` 序列化成字符串导致 400）+ 管理端 401 统一清会话跳登录页（参与者端不跳，由页面自处理 `?redirect=` 回跳）。
- 登录/注册路径：参与者在 `/login` 和报名链路使用手机号+验证码，首次验证自动建号；原用户名+密码入口只用于存量账号登录后绑定手机号。机构管理员走 `authWithPassword` + 邀请码注册端点；超管无注册入口。
- 路由守卫 `RequireRole`（`shared/guards.tsx`）：本角色会话有效→放行；持其它角色会话→403 页；未登录→跳对应登录页。**守卫只是 UX，权限永远由服务端 rules/hooks 强制**——改权限不要只改前端。
- 会话响应式：`useSessionSnapshot()`（useSyncExternalStore 订阅三个 authStore）。

### 6.4 数据获取与错误处理约定

无请求库，两种模式：集合数据用 `collectionsForRole(role).xxx.getList(...)` 直接调 SDK；业务动作用各 feature 的 api 模块封装走 `shared/api/http.ts` 的 `apiGet/apiPost`（错误规范化为 `ApiError{status, code, details}`，业务错误码从 `details.code` 读）。页面级统一手写 `useState(data/error/loading) + useEffect(cancelled 标志) + useCallback(reload)`。导出下载是特例：原生 fetch + Authorization + blob。T3 的 `features/admin/lib/activityLive.ts` 先建立 Realtime 订阅再首取快照，事件仅触发防抖重取，并在断线/重连时更新连接状态与刷新快照。T5 的 `features/participant/lib/myPairingLive.ts` + `lib/useMyPairing.ts` 把同一模式用于参与者本人配对状态（订阅本人 `checkins` + `cc.participant.pairing.<participantId>` topic，重拉 `my-pairing`；订阅失败降级为一次性快照 + 离线提示；后台刷新失败保留旧快照并经 error 标记陈旧）：签到成功页/活动详情页用单活动容器 `components/MyPairingCard.tsx`（PRD §5.3 五态，文字 + 状态图标 + 颜色共同表达），「我的」中心用页面级 `useMyPairingMap` 单订阅多活动 + 纯展示 `MyPairingCardView`，且仅已通过审核的报名条目挂载配对卡。

### 6.5 路由清单

| 区 | 路由 |
|---|---|
| 参与者 `/`（公开页不要求登录） | `/` 落地页（现有活动最近 2 场、往期活动公开推文最近 2 篇）、`/activities` 现有活动（仅未结束场次）、`/activities/past` 全部公开推文、`/a/:activityId` 详情、`/a/:activityId/register` 报名、`/login`；需会话：`/me` 我的、`/checkin/:token` 扫码签到、`/survey/:qrToken` 填问卷、`/trainings`、`/training-checkin/:token` |
| 机构 `/admin` | 公开：`/admin/login`、`/admin/register`（邀请码 + 用户名 + 邮箱 + 密码）；守卫：`/admin/activities`（+`/new` T4 分步创建向导、`/:activityId` 生命周期面板 + 五 tab 详情含「现场工作台」）、`/admin/trainings`(+`/:id`)、`/admin/dashboard`、`/admin/exports`、`/admin/audit` |
| 超管 `/super` | 公开：`/super/login`；守卫：`/super/organizations`（机构+邀请码+开关）、`/super/approvals`、`/super/activities`、`/super/posts`（内容推文）、`/super/dashboard`、`/super/exports`、`/super/audit`、`/super/system`（备份告警+模板管理） |

### 6.6 样式体系

纯手写 CSS，三个文件：`shared/styles/global.css`（`:root` 设计 token——`--cc-brand/neutral/success/...` 色系、圆角阴影动效，**组件不写死 hex**；`.cc-*` 共享类），分区样式 `participant.css`(`.ccp-*`)、`admin.css`(`.admin-*`)、`superadmin.css`(`.sa-*`) 由各端 barrel 引入只随本端加载。视觉规范见 `docs/planning/ui-design.md`。

### 6.7 前端测试

Vitest + jsdom + Testing Library，51 个测试文件与源码 colocate，主力打**纯函数 lib**（状态机、文案、表单校验）与页面行为（`src/test/mockApi.ts` 的 `stubApi()` 按"METHOD 路径片段"stub fetch，`makeTestToken/saveParticipantSession` 注入登录态）；`router.test.tsx` 用 MemoryRouter 验证三分区守卫。运行 `npm test`。

## 7. 端到端业务流程（前后端串起来）

**参与者主链路**：广场/详情（`GET /api/cc/public/activities*`）→ 报名页请求并验证手机号验证码（首次自动建号；存量用户名账号先登录再绑定）→ 提交报名（`POST .../register`，按所选角色的 role_scope 字段渲染表单）→ 在 `/me`（`GET /api/cc/me/overview`）看审核状态和绑定/换绑手机号 → 到场扫固定二维码 → `POST /api/cc/checkin/self`（幂等）→ 活动后问卷草稿/提交。

**机构管理员日常**：建活动（draft）→ （如机构开审核则提交审批）→ 发布 → 审核报名（transition，事务内名额硬校验）→ 现场工作台开放签到、配对与问卷 → 用五步向导按范围/数据域/行列生成 XLSX 或 CSV ZIP → 培训同理。旧 v1 固定 13 CSV 仅作一个发布窗口的兼容入口。

**超管**：建机构、生成一次性邀请码（明文只展示一次）、机构开关（发布审核/敏感导出）、活动审批/下架、内容推文管理（`/super/posts`，置顶/显隐，无硬删除）、问卷模板版本管理、全局看板/导出/审计、备份告警（`/super/system`）。

**数据出口**：导出 ZIP → 外部分析 agent 经 `mcp/` MCP server 取数（`export_activity_data` 恒 `include_pii:false`，只回文件路径不回正文）→ 报告经 `upload_report` 回传 `reports` 集合（强制 draft，人工审核发布，钩子记 `report.upload` 审计）。

MCP 是由 WorkBuddy、Kimi、Claude、Codex 等本地客户端启动的 STDIO 进程，Chat Circles 后端 URL
只是它访问 PocketBase 的地址，不是远程 MCP 端点。不同客户端的完整配置、未备案期间安全接入与 SSH
隧道、首次验收、云端 agent 限制见 [`mcp/README.md`](../mcp/README.md)。

## 8. 常见修改食谱

**加一个集合 / 加字段**
1. 新建 `backend/pb_migrations/<新时间戳>_cc_<域名>.js`（遵守 §5.6 约定：显式 created/updated、bool 不 required、cascadeDelete false、deleteRule null、合适的 API rules）。
2. 同步 `frontend/src/shared/api/types.ts`（类型+枚举）与 `collections.ts`。
3. 跑 `bash backend/tests/migration_smoke.sh`（up/down 往返）与集成套件。
4. 集合若带 `organization_id`：**同 PR 在 `suite_acl.py` 补越权用例**（强制）。

**加一个业务端点（写操作）**
1. 若属于手机号/现场配对/活动快照/细粒度导出，先对照 `docs/planning/api-design.md` 与 `shared/api/accountEvent.ts`，禁止在 feature 内改机器名或重定义同义类型；T3 快照还必须保持“Realtime 只失效、服务端重算”的边界。
2. 在对应域的 `pb_hooks/*.pb.js` 加 `routerAdd`：用本文件内联的 `requireAuth`/`ccError`/`writeAudit` 等工具；机构资源一律服务端注入 organization_id，跨机构 404；写操作放事务内并写审计。
3. 需要封堵直连写时同步 `guards.pb.js`。
4. 集成测试：对应 suite 补断言；新机构资源必须同 PR 补 `suite_acl.py`；注意 auth 预算（§5.7）。
5. 前端：在对应 feature 的 `api.ts` 加封装，直接 import 共享请求/响应类型，并更新文件头契约注释。

**改报名字段**：字段是**数据**不是代码——平台标准字段由超管维护 `registration_field_defs`（`organization_id=''`），机构自定义字段机构自己加；`role_scope` 控制按角色展示/校验，`is_sensitive` 控制导出过滤。前端分角色渲染逻辑在 `features/participant/lib/registrationForm.ts`。

**加看板指标**：后端 `metrics.pb.js` 注册表加 key（口径写进文件头注释）+ 前端 `shared/metrics/registry.ts` 加定义；管理端看板按注册表渲染，不用改页面。

**改 UI**：改 token 去 `global.css`；组件样式跟随 `.cc-/.ccp-/.admin-/.sa-` 前缀约定；业务口径不要从 UI 层发起变更。

**升级 PocketBase**：四处必须同步——`.env.example` 的 `PB_VERSION`、`Dockerfile` 的 `ARG PB_VERSION` + `PB_SHA256`、`.github/workflows/ci.yml` 与 `e2e.yml`、backend 测试脚本内常量。

**改 `pb_hooks/lib/` 契约函数**：改完必须同步所有领域文件里的内联副本（grep 函数名找全）。这是 §4 说过的最大陷阱，再强调一次。

## 9. 测试与 CI

三层测试：

| 层 | 位置 | 运行 | 覆盖 |
|---|---|---|---|
| 前端单元/组件 | `frontend/src/**/*.test.*` | `cd frontend && npm test` | 当前 55 files / 410 tests：页面/组件行为、路由守卫、手机号交互、Realtime 失效化、工作台口径、配对卡五态与导出向导 |
| 后端集成 + 迁移冒烟 | `backend/tests/` | `bash backend/tests/run_integration.sh`、`migration_smoke.sh` | 越权矩阵、状态机、并发名额、导出、限流、无硬删除……（AC-01~23 映射见 docs/planning/test-plan.md） |
| E2E 主链路 | `e2e/` | `cd e2e && npm test`（环境全自动自举，与本地库隔离） | 手机号登录→报名→审核→双角色签到/配对/Realtime→问卷→细粒度导出，外加培训链路 |
| T7 发布验收 | `scripts/t7-release-acceptance.sh` | `bash scripts/t7-release-acceptance.sh` | 串联配置 15 项、hooks/备份语法、前端、迁移、后端集成与 E2E；不部署、不读真实 `.env` |

CI（`.github/workflows/ci.yml`，push 到 main 与全部 PR 触发，三 job 均为 PR 必过）：`frontend`（lint→typecheck→test→build）、`backend-migrations`（空目录 migrate up + `node --check` 全部 hooks）、`backend-integration`（全量集成套件）。另有 `e2e.yml`（PR + 每日 cron）与 `deploy.yml`（push main 自动部署）。

## 10. 部署与运维速览

- **一体化镜像**（根 `Dockerfile`）：stage1 构建前端 → stage2 alpine 下载 PB 0.28.4（sha256 硬校验）+ 拷入 `pb_public`/`pb_migrations`/`pb_hooks`；`VOLUME /pb/pb_data`；容器启动时 `serve` 自动应用迁移（与本地需手动 `migrate up` 不同）。
- **compose 三服务**：`app`（生产基础 compose 默认不向 host 发布端口，只在 Docker 私网供 Caddy/backup 以 app:8090 访问；显式叠加 `deploy/docker-compose.debug.yml` 才发布回环 `127.0.0.1:8090`）、`backup`（crond 每日北京时间 02:00 跑 `deploy/backup.sh`：PB `/api/backups` 一致性快照 → 下载 ZIP → 校验 → 删服务端副本 → 30 天滚动 → 写 `last_backup.json` 标记并直写 `audit_logs` 驱动超管告警）、`caddy`（TLS 走阿里云 DNS-01，安全响应头，封 `/_/*` 管理台，反代 app:8090 并覆写 XFF）。
- **部署流水线**：push main → `deploy.yml` SSH 到 ECS `/opt/chatcircle` → `git merge --ff-only origin/main` → `docker compose up --build -d`。
- **恢复**：stop app → 用 `cc_daily_*.zip` 覆盖 pb_data → start（compose 文件尾注释）。
- **环境变量**：全部见 `.env.example`（PB 版本、备份保留天数、超管与 agent 服务账号凭据、阿里云密钥；真实 .env 不入库）。
- 细节与已知未验证项（Docker 构建/备份脚本在真实容器环境的验证状态、服务器上待删的 override 文件）以 `deploy/README.md` 为准。

## 11. 红线速查（改代码前必读）

1. schema 变更只能经 `pb_migrations/`，禁止在生产 admin UI 手改结构。
2. 业务规则只写在 `pb_hooks/` 与 API rules；前端校验仅是体验层。
3. 无硬删除：停用/归档/作废/撤销用 status 表达，任何集合不开 delete。
4. 机构隔离在服务端强制：自定义端点内 organization_id 由服务端注入，放行的直连 create 由客户端传本机构值并经 API rules 校验；跨机构 404；新增带 organization_id 的接口必须同 PR 补越权测试。
5. 敏感数据导出只看 `is_sensitive` 标记位，禁止字段名启发式。
6. 审计与业务写同事务；metadata 不含密码/完整敏感答案。
7. hooks 无环境变量、无跨文件共享；改 `lib/` 契约必须同步全部内联副本。
8. 集成测试的内置认证预算仅余 3 次（§5.7）；`suite_hardening.py` 必须是 runner 中最后一个使用内置认证的 suite。
9. Realtime payload 不承载权威指标；事件只使快照失效，最终数值必须重新读取服务端同快照汇总。
10. 环境差异走环境变量：`.env.example` 入库，真实 `.env` 与 secrets 不入库。
11. 需求口径以 PRD v0.3 为基线；业务口径变更先回 `docs/planning/` 评审，再改代码。

---

*本文随代码同步维护：改了本文涉及的机制（目录结构、端点清单、状态机、约定），请同 PR 更新本文。*
