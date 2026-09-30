# Chat Circles 开发者指南

面向首次接手仓库的开发者与 agent。先按本文启动本地环境，再按修改领域阅读[文档索引](README.md)。业务规则见 [business-rules.md](business-rules.md)，现有维护缺口见 [maintenance.md](maintenance.md)。实现以当前代码、迁移和测试为准；文档变更与相关代码同 PR 维护。

## 1. 项目一页纸

**Chat Circles** 是 Empact 统一运营的**多机构活动管理 / 报名审核 / 签到 / 问卷 / 聆听者培训平台**。它把公益心理陪伴活动的报名、签到、问卷从微信群和零散表格搬到统一网站上。正式域名 `chatcircle.empact.cn`。

核心业务闭环（一条数据的完整生命周期）：

```
机构建活动(发布/审批) → 参与者报名 → 机构人工审核 → 现场扫固定二维码签到 → 活动后填问卷 → 机构/平台看板与导出 → 外部 agent 出报告回传
```

三类用户角色（注意与"活动内角色"区分）：

| 角色 | 后端身份 | 数据范围 |
|---|---|---|
| 超级管理员 | PocketBase `_superusers` | 全平台 |
| 机构管理员 | `admin_accounts`（auth 集合，带 `organization_id`） | 仅本机构 |
| 参与者 | `participant_accounts`（auth 集合，不绑机构；用户名/手机号+密码为 T2 主登录身份，手机验证码登录为备选） | 仅本人 |

「倾诉者 speaker / 聆听者 listener」**不是平台角色**，而是每条报名记录上的 `activity_role`；同一参与者可在不同活动选不同角色。聆听者培训是与活动解绑的独立体系：签到资格 = 该账号在全平台任一活动有 approved 的 listener 报名。

技术形态一句话：**React 18 + Vite + TypeScript 单 SPA（手机优先，按角色分 `/`、`/admin`、`/super` 三区）+ PocketBase 0.39.7（认证 / API rules / pb_hooks 业务规则 / SQLite）+ Docker Compose 四服务部署（功能 SPA 由 PocketBase 从 `pb_public/` 同源伺服，公开页由独立 public-web 做 SSR）**。

## 2. 仓库地图

```
├── frontend/            # React SPA。src/features/{participant,admin,superadmin} + src/shared/
│                        #   详见 frontend 各节；操作手册级内容不在这里，全在本文 §6
│                        #   另有 src/public/ + server/（公开页 SSR，见 §6.8），构建产物 dist-public/
├── backend/             # PocketBase 后端
│   ├── pb_migrations/   #   版本化 schema、索引与访问规则，schema 变更的唯一入口
│   ├── pb_hooks/        #   服务端业务规则（JSVM *.pb.js）：自定义路由 + Realtime 守卫 + 写守卫 + 审计
│   ├── tests/           #   L3 集成套件 + 迁移冒烟（CI 必过），仅用 bash/curl/python3 标准库
│   ├── scripts/         #   种子数据、历史数据补录
│   ├── pb_data/         #   本地开发数据（SQLite），【不入库】
│   ├── pb_public/       #   前端产物放置处，PocketBase 同源伺服，【不入库】
│   └── pocketbase       #   二进制需手工下载，【不入库】
├── mcp/                 # 给数据分析 agent 用的 MCP server（取数走导出 API、报告回传 reports 集合）
├── e2e/                 # Playwright 主链路端到端测试（L4）
├── deploy/              # backup.sh 每日备份、Caddy 反代配置、public-web 镜像与 smoke、生产部署手册
├── docs/
│   ├── developer-guide.md      # 本文：代码现状与修改指南
│   ├── README.md               # 接手阅读顺序与专题索引
│   └── maintenance.md          # 尚未完成的维护事项与验收边界
├── .github/workflows/   # ci.yml（PR 必过）/ deploy.yml（推 main 自动部署）/ e2e.yml
├── Dockerfile           # 多阶段：前端 build → PocketBase 运行时（一体化镜像）
├── docker-compose.yml   # app + public-web + backup + caddy 四服务
└── .env.example         # 全部环境变量（真实 .env 与 secrets 不入库）
```

## 3. 本地开发环境

前置：Node.js 22、npm、Python 3、curl/unzip，以及与 `.env.example` / CI 一致的 PocketBase **0.39.7**。下载和目录参数见 [backend/README.md](../backend/README.md)。不要把旧的本地二进制或生产数据当作新环境。

以下均从仓库根目录开始；命令使用本地测试配置，mock 验证码只用于开发：

```sh
# 终端 1：后端
cd backend
export CC_ENVIRONMENT=development
export CC_SMS_PROVIDER=mock
export CC_SMS_MOCK_CODE=246810
export CC_PHONE_HASH_KEY=local-development-only-phone-hash-key
./pocketbase migrate up --dir pb_data --migrationsDir pb_migrations --hooksDir pb_hooks
# 首次按 backend/README.md 创建本地超级管理员
./pocketbase serve --dir pb_data --migrationsDir pb_migrations --hooksDir pb_hooks
```

```sh
# 终端 2：前端；/api 代理到 127.0.0.1:8090
npm ci --prefix frontend
npm run dev --prefix frontend
```

后端健康检查：`http://127.0.0.1:8090/api/cc/health`；开发管理台：`http://127.0.0.1:8090/_/`。前端地址以 Vite 输出为准。

可选演示数据见后端手册：种子脚本会自行启动临时实例，必须先停止使用同一数据库的服务；已有超管时通过 `SEED_SU_EMAIL` / `SEED_SU_PASS` 传入本地账号，不能混用脚本默认密码。日常开发不需要生产短信或 SMTP 凭据。

公开页 SSR 另行执行 `npm run build:public --prefix frontend` 和 `npm run start:public --prefix frontend`（默认 3100，上游默认本地 8090），见 [public-web.md](public-web.md)。Vite 开发服务只覆盖 SPA。

生产 Compose 的必填变量是 `CC_PHONE_HASH_KEY` 和 `CC_BACKUP_KEY`；backup 不再使用超管凭据。生产短信还需要阿里云场景模板与 RAM 凭据。完整配置和四服务启动见 [部署手册](../deploy/README.md)，日常本地开发优先使用上述原生方式。基础 Compose 不开放宿主机 8090，调试时才显式叠加 `deploy/docker-compose.debug.yml`，不要把调试覆盖带到生产。

常用端口约定：开发后端 8090 / 种子脚本临时实例 8096 / 集成测试 8097 / 迁移冒烟 8099 / e2e 18090+14173。

## 4. 架构总览：先建立这五个心智模型

1. **写入收口**。几乎所有业务写操作（报名、审核、签到、问卷、导出、邀请码……）都只走 `pb_hooks` 里的自定义端点（`POST /api/cc/*`），在服务端事务内完成；集合的直连 create/update 被 `guards.pb.js` 等守卫封堵，直连 delete 全部集合关闭。前端集合 API 主要用于**读**。
2. **读路径分两路**。管理端读集合走 PocketBase 原生 API + API rules（机构隔离靠 rule 里的 `@request.auth.organization_id` 链式反查）；参与者读公开/聚合信息走 hooks 白名单端点（`/api/cc/public/*`、`/api/cc/me/*`），不直连集合。
3. **机构隔离在服务端强制**。写路径分两种：**自定义端点**内 `organization_id` 一律由 hooks 从登录身份注入，客户端传入的会被忽略；少数放行的**集合直连 create**（活动、培训、机构自定义报名字段）则由前端显式传本机构 `organization_id`（取自登录管理员身份，如 `ActivityForm.tsx`），由 API rules 校验 `@request.auth.organization_id = organization_id`，且 guards 禁止 update 再改它。读路径靠 rules 按身份过滤。跨机构访问返回 **404 而非 403**（不泄露资源存在性）。
4. **无硬删除**。业务集合对普通用户关闭 delete；停用/归档/作废/撤销/释放一律用状态字段表达（FR-AUD-001）。日常操作不引入硬删除；依法处理个人信息删除请求按[隐私运营手册](privacy-operations.md)执行。
5. **pb_hooks 是隔离作用域的 JS，不是 Node 项目**。PocketBase JSVM 中各 `*.pb.js` 文件作用域完全隔离，没有 import/全局共享。`pb_hooks/lib/` 下的 http/ratelimit/audit 等文件是**契约标准源，运行时不会被加载**；每个领域文件把所需工具函数**原样内联**在自己闭包里。**改 lib 语义后必须同步所有内联副本**——这是本仓库最大的维护陷阱（文件头部有"勿手工改副本"警告）。

整体请求路径（生产）：浏览器 → Caddy（TLS、安全头、封 `/_/*`、按路径分发）→ 公开路由走 public-web:3100（SSR），`/api/*` 与功能 SPA 走 PocketBase（`pb_public/` 静态前端 + 集合 API + `/api/cc/*` hooks）→ SQLite。public-web 的上游也只有 PocketBase（匿名公开端点）。

## 5. 后端详解

### 5.1 数据模型概览

schema 定义全部在 `backend/pb_migrations/`，一个迁移文件建一个域（命名 `<Unix时间戳>_cc_<域名>.js`，按时间戳排序执行）。按域分组：

**账号与机构**

| 集合 | 用途与关键字段 |
|---|---|
| `organizations` | 机构主数据 + 机构级开关：`status`(active/disabled)、`require_activity_approval`（活动发布需平台审核）、`allow_sensitive_export`（敏感导出开关） |
| `admin_accounts` (auth) | 机构管理员：username+密码、`organization_id`、`status`；`authRule: status='active'` 拒绝停用账号登录；token 7 天 |
| `admin_invites` | 一次性管理员邀请码：**只存 `token_hash`**（sha256），明文仅生成时返回一次；`status`(unused/used/revoked/expired)、`expires_at`（默认 7 天） |
| `participant_accounts` (auth) | 参与者：T2 起「用户名/手机号 + 密码」为主登录身份，手机验证码登录为备选；完整 `phone_e164` 与 HMAC 查找值为 hidden，公开响应仅给掩码/绑定状态；token 30 天 |
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
| `checkin_sessions` | 签到开放窗口："未开放"不建行，每次开放新建一行、关闭置 `closed`；"同时至多一条 open"由 hooks 事务保证（当前由应用层维护） |
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

### 5.4 接口与代码入口

请求/响应机器类型见 `frontend/src/shared/api/accountEvent.ts`，关键权限、幂等、实时与导出语义见 [API 契约](api-contracts.md)。完整路由直接查看各文件的 `routerAdd`，避免维护第二份易过时的端点全集。

| 领域 | `backend/pb_hooks/` 中的入口 |
| --- | --- |
| 账号密码、邀请码、短信、管理员邮件 | `auth.pb.js`、`authguard.pb.js`、`phoneauth.pb.js`、`mailguard.pb.js` |
| 活动、报名、签到、现场配对与快照 | `activities.pb.js`、`registrations.pb.js`、`checkins.pb.js`、`pairings.pb.js`、`live.pb.js` |
| 问卷、答卷、培训 | `surveys.pb.js`、`submissions.pb.js`、`trainings.pb.js` |
| 看板、导出、报告、推文 | `metrics.pb.js`、`exports.pb.js`、`exports_v2.pb.js`、`reports.pb.js`、`posts.pb.js` |
| 超管、写守卫、姓名/模板约束 | `super.pb.js`、`guards.pb.js`、`release.pb.js` |
| 内部备份、公开健康检查 | `backup.pb.js`、`main.pb.js` |

```sh
rg -n 'routerAdd' backend/pb_hooks
```

### 5.5 横切机制

- **审计**：`writeAudit(app, entry)`，约定与业务写**同事务**（事务内传 txApp）。动作代码分布见各域文件；改业务动作时别忘了补审计。
- **限流**：部分窗口存在 `$app.store()`，部分认证/导出额度通过数据库事务持久化；分别查看 `authguard.pb.js`、`phoneauth.pb.js` 与导出实现，不假定所有限流重启即清空。生产经 Caddy 反代必须启用 trusted proxy headers（迁移 `1785889200` 已设 `X-Forwarded-For`），否则 per-IP 限流退化为全平台共享桶。
- **敏感导出过滤**：普通导出按 `registration_field_defs.is_sensitive` 与 `survey_questions.is_sensitive` 两个标记位排除（**禁止按字段名启发式判断**），participants.csv 不含 username；敏感导出需机构开关 + `confirm:true` 二次确认 + 独立审计动作。CSV 公式注入防护（`= + - @ Tab` 前置单引号）。导出文件落 `pb_data/exports`（0700/0600），文件名随机，下载有路径前缀防护。
- **名额并发**：报名创建端点只是预检，**硬校验在 transition 到 approved 的事务内**（总名额+角色名额双查）；SQLite busy 类错误重试 2 次后 409。
- **错误形态**：统一 `{code, message, data:{code}}`；handler 抛 `ccError` 由顶层 catch 转换，事务内抛出即回滚。部分文件（surveys/submissions/exports/super/metrics）混用 `jsonError` 直接 return 形态——改代码时跟随本文件既有风格。
- **Realtime 只做失效通知**：管理端订阅 activities/registrations/checkins/activity_surveys/submissions/activity_pairs 后统一防抖重取 `live-summary`，不从事件 payload 推导指标；参与者只能订阅自己的 `cc.participant.pairing.<participantId>` 主题，且消息发送前再次按当前认证清洗。人口统计任一桶小于 5 时，该维度全部桶一起抑制，防止结合已通过总数做减法反推。
- **配置**：hooks 通过 `$os.getenv()` 读取手机号 HMAC、短信 provider、备份密钥等环境变量；清单见 `.env.example` 与 Compose 的透传配置。新增配置须同步示例、运行时校验和发布门禁，不打印值。

### 5.6 迁移编写约定

- 结构 `migrate((app) => {up}, (app) => {down})`，为 down 写明可逆范围（冒烟脚本做 up→down→up 往返验证）；保留业务数据的迁移不保证恢复旧业务行为，不能将 schema down 等同生产回滚。
- 沿用仓库迁移约定：每个集合显式声明两个 autodate 字段。
- `bool` 一律 `required: false`（避免 required bool 强制取 true）。
- 空 relation 存 `''` 而非 NULL（"平台级 vs 机构级"用 `organization_id = ''` 表达，空串可参与唯一索引）。
- relation 一律 `cascadeDelete: false`（配合无硬删除）。
- 当前开放场次等条件唯一性由 hooks 事务保证；新增约束先核对迁移与并发测试，不用全量唯一索引误伤历史记录。
- 注意 `migrate` 失败退出码也可能为 0：脚本都要 grep 输出中的 `Error`（测试脚本已这么处理）。

### 5.7 后端测试体系

[后端测试手册](../backend/tests/README.md)说明隔离数据库、fixture、端口和升级测试。新增可关联 `organization_id` 的接口必须同 PR 补越权用例。避免新增不必要的内置 `auth-with-password` 调用耗尽 IP 限流预算，使用 fixture 的 impersonate 工厂；保留 runner 对限流套件的顺序约束。

## 6. 前端详解（`frontend/`）

### 6.1 技术选型

极简依赖：react/react-dom 18、react-router-dom 7、pocketbase SDK 0.21（既是 HTTP client 也是 auth 存储）、qrcode（管理端本地生成二维码 dataURL）。**没有**状态库、UI 库、CSS 框架、图表库（看板是纯数字卡片）。状态管理 = useState/useEffect + PB authStore 订阅。构建脚本 `build = tsc --noEmit && vite build`（先类型检查）。

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
- 登录/注册路径：参与者在 `/login` 和报名链路用「用户名/手机号+密码」登录或「用户名+密码+手机号」注册；手机号验证码登录为备选（仅已注册账号）。机构管理员走 `authWithPassword` + 邀请码注册端点；超管无注册入口。
- 路由守卫 `RequireRole`（`shared/guards.tsx`）：本角色会话有效→放行；持其它角色会话→403 页；未登录→跳对应登录页。**守卫只是 UX，权限永远由服务端 rules/hooks 强制**——改权限不要只改前端。
- 会话响应式：`useSessionSnapshot()`（useSyncExternalStore 订阅三个 authStore）。

### 6.4 数据获取与错误处理约定

无请求库，两种模式：集合数据用 `collectionsForRole(role).xxx.getList(...)` 直接调 SDK；业务动作用各 feature 的 api 模块封装走 `shared/api/http.ts` 的 `apiGet/apiPost`（错误规范化为 `ApiError{status, code, details}`，业务错误码从 `details.code` 读）。页面级统一手写 `useState(data/error/loading) + useEffect(cancelled 标志) + useCallback(reload)`。导出下载是特例：原生 fetch + Authorization + blob。T3 的 `features/admin/lib/activityLive.ts` 先建立 Realtime 订阅再首取快照，事件仅触发防抖重取，并在断线/重连时更新连接状态与刷新快照。T5 的 `features/participant/lib/myPairingLive.ts` + `lib/useMyPairing.ts` 把同一模式用于参与者本人配对状态（订阅本人 `checkins` + `cc.participant.pairing.<participantId>` topic，重拉 `my-pairing`；订阅失败降级为一次性快照 + 离线提示；后台刷新失败保留旧快照并经 error 标记陈旧）：签到成功页/活动详情页用单活动容器 `components/MyPairingCard.tsx`（文字 + 状态图标 + 颜色共同表达），「我的」中心用页面级 `useMyPairingMap` 单订阅多活动 + 纯展示 `MyPairingCardView`，且仅已通过审核的报名条目挂载配对卡。

### 6.5 路由清单

| 区 | 路由 |
|---|---|
| 参与者 `/`（公开页不要求登录） | `/` 落地页（现有活动最近 2 场、往期活动公开推文最近 2 篇）、`/activities` 现有活动（仅未结束场次）、`/activities/past` 全部公开推文、`/a/:activityId` 详情、`/a/:activityId/register` 报名、`/login`；需会话：`/me` 我的、`/checkin/:token` 扫码签到、`/survey/:qrToken` 填问卷、`/trainings`、`/training-checkin/:token` |
| 机构 `/admin` | 公开：`/admin/login`、`/admin/email-login`、`/admin/verify-email`、`/admin/reset-password`、`/admin/register`（邀请码 + 用户名 + 邮箱 + 密码）；守卫：`/admin/activities`（+`/new` T4 分步创建向导、`/:activityId` 生命周期面板 + 五 tab 详情含「现场工作台」）、`/admin/trainings`(+`/:id`)、`/admin/dashboard`、`/admin/exports`、`/admin/audit` |
| 超管 `/super` | 公开：`/super/login`；守卫：`/super/organizations`（机构+邀请码+开关）、`/super/approvals`、`/super/activities`、`/super/posts`（内容推文）、`/super/dashboard`、`/super/exports`、`/super/audit`、`/super/system`（备份告警+模板管理） |

### 6.6 样式体系

纯手写 CSS，三个文件：`shared/styles/global.css`（`:root` 设计 token——`--cc-brand/neutral/success/...` 色系、圆角阴影动效，**组件不写死 hex**；`.cc-*` 共享类），分区样式 `participant.css`(`.ccp-*`)、`admin.css`(`.admin-*`)、`superadmin.css`(`.sa-*`) 由各端 barrel 引入只随本端加载。公开端同时有首页样式覆盖；以现有 CSS 与实际页面为准，移动端可用性要求见 [业务规则](business-rules.md)。

### 6.7 前端测试

Vitest + jsdom + Testing Library，测试文件与源码 colocate，主力打**纯函数 lib**（状态机、文案、表单校验）与页面行为（`src/test/mockApi.ts` 的 `stubApi()` 按"METHOD 路径片段"stub fetch，`makeTestToken/saveParticipantSession` 注入登录态）；`router.test.tsx` 用 MemoryRouter 验证三分区守卫。运行 `npm test`。

### 6.8 公开页 SSR / GEO

公开页（`/`、`/about`、`/privacy`、`/activities`、`/activities/past`、`/a/:id`、`/posts/:id`）由独立的渲染服务 `public-web` 做服务端渲染，让搜索引擎与无 JS 抓取方直接读到正文与元信息；功能页（登录后的业务界面）仍是原 SPA。设计决策与否决方案见 [public-web.md](public-web.md)。

```text
浏览器/爬虫
  ▼
Caddy（按路径精确分发，见 deploy/Caddyfile 文件头注释）
  ├─ 公开页 + /public-assets/* + /robots.txt + /sitemap.xml + 未知路径 → public-web:3100（SSR）
  │     │ 仅匿名公开端点（/api/cc/public/*、posts 集合）
  │     ▼
  └─ /api/* + /assets/* + 功能 SPA（/login /me /admin/* /super/* /a/:id/register …）→ app:8090
                                  ↑ public-web 的上游也是它
```

- **公开数据层白名单原则**：`src/public/data.ts` 只调匿名可读的公开端点，且所有响应经白名单 mapper 收窄成 `src/public/types.ts` 的 DTO——`registration_fields`、`created_by/updated_by`、手机号等字段一律剔除，不得进入公开 HTML。新增公开页字段 = 先加 DTO 字段再加 mapper，**不得直接透传上游 JSON**。草稿/下架/隐藏内容返回 404 通用页，不泄露存在性。
- **代码位置**：`src/public/`（路由、元信息、数据层、视图，渲染与 SPA 共用组件）、`server/`（node:http 服务，无框架无运行时依赖）；构建产物 `dist-public/{client,server}`。
- **命令**：`npm run build:public`（client + server 两个 bundle）、`npm run start:public`（本地起渲染服务，默认 3100）、`npm run test:public`（`src/public` + `server` 的 vitest 子集）。配置项见 `server/config.ts`（`PORT` / `CC_SITE_ORIGIN` / `CC_PB_INTERNAL_URL` / `CC_PUBLIC_FETCH_TIMEOUT_MS` / `CC_PUBLIC_MAX_INFLIGHT`，全部非密钥）。
- **路由分界**：Caddy path matcher 无通配符即精确匹配；`/a/:id/register`（功能页）必须在 `/a/*`（公开详情）之前命中；未知路径一律由渲染服务回真实 404（不再是 SPA 假 200）。**新增公开/功能路由时三处同步**：`src/public/routes.ts`、`src/router.tsx`、`deploy/Caddyfile`（`deploy/verify-release-config.mjs` 会静态守住 Caddy 一侧）。
- **元信息口径**：每页 `title/description/canonical/og:*` 由 `src/public/metadata.ts` 生成；首帧数据以 `<script type="application/json" id="__CC_PUBLIC_DATA__">` 内嵌（非可执行脚本，CSP 无需放行 inline script），客户端 hydrate 直接复用。`robots.txt` 由渲染服务下发（功能路径 Disallow + GPTBot 全站退出 + Sitemap 行），功能 SPA 路径另有 Caddy 服务端 `X-Robots-Tag: noindex` 双保险；`sitemap.xml` 只列当前会返回 200 的 URL，上游失败时 503，绝不返回空 sitemap 伪装成功。
- **无 JS 可读验证**：

```sh
npm run build:public && npm run start:public   # 另需本地 PocketBase 在 8090
curl -s http://127.0.0.1:3100/ | grep -o 'rel="canonical"'        # SSR 元信息
curl -s http://127.0.0.1:3100/ | grep -c '__CC_PUBLIC_DATA__'     # 首帧数据标记
curl -s http://127.0.0.1:3100/robots.txt                          # Disallow 与 Sitemap 行
```

线上口径同理（`https://chatcircle.empact.cn/`），部署门禁已自动化这三项断言。

## 7. 端到端业务流程（前后端串起来）

**参与者主链路**：广场/详情（`GET /api/cc/public/activities*`）→ 登录/注册（用户名/手机号+密码，或手机号验证码；新用户须在 `/login` 或报名链路用「用户名+密码+手机号」注册，首次验证不再自动建号）→ 提交报名（`POST .../register`，按所选角色的 role_scope 字段渲染表单）→ 在 `/me`（`GET /api/cc/me/overview`）看审核状态和绑定/换绑手机号 → 到场扫固定二维码 → `POST /api/cc/checkin/self`（幂等）→ 活动后问卷草稿/提交。

**机构管理员日常**：建活动（draft）→ （如机构开审核则提交审批）→ 发布 → 审核报名（transition，事务内名额硬校验）→ 现场工作台开放签到、配对与问卷 → 用五步向导按范围/数据域/行列生成 XLSX 或 CSV ZIP → 培训同理。旧 v1 固定 13 CSV 仍供 MCP 使用，不得仅因旧计划写过过渡期就下线。

**超管**：建机构、生成一次性邀请码（明文只展示一次）、机构开关（发布审核/敏感导出）、活动审批/下架、内容推文管理（`/super/posts`，置顶/显隐，无硬删除）、问卷模板版本管理、全局看板/导出/审计、备份告警（`/super/system`）。

**数据出口**：导出 ZIP → 外部分析 agent 经 `mcp/` MCP server 取数（`export_activity_data` 恒 `include_pii:false`，只回文件路径不回正文）→ 报告经 `upload_report` 回传 `reports` 集合（强制 draft，人工审核发布，钩子记 `report.upload` 审计）。

MCP 是由 WorkBuddy、Kimi、Claude、Codex 等本地客户端启动的 STDIO 进程，Chat Circles 后端 URL
只是它访问 PocketBase 的地址，不是远程 MCP 端点。不同客户端的完整配置、首次登录与验收、云端 agent 限制见 [`mcp/README.md`](../mcp/README.md)。

## 8. 常见修改食谱

**加一个集合 / 加字段**
1. 新建 `backend/pb_migrations/<新时间戳>_cc_<域名>.js`（遵守 §5.6 约定：显式 created/updated、bool 不 required、cascadeDelete false、deleteRule null、合适的 API rules）。
2. 同步 `frontend/src/shared/api/types.ts`（类型+枚举）与 `collections.ts`。
3. 跑 `bash backend/tests/migration_smoke.sh`（up/down 往返）与集成套件。
4. 集合若带 `organization_id`：**同 PR 在 `suite_acl.py` 补越权用例**（强制）。

**加一个业务端点（写操作）**
1. 若属于手机号/现场配对/活动快照/细粒度导出，先对照 [API 契约](api-contracts.md) 与 `shared/api/accountEvent.ts`，禁止在 feature 内改机器名或重定义同义类型；T3 快照还必须保持“Realtime 只失效、服务端重算”的边界。
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

按修改范围运行最小有意义的检查，发布前再按[发布清单](release-checklist.md)验收。不在文档固定测试总数，以本次输出为准。

| 修改范围 | 从仓库根目录运行 |
| --- | --- |
| 前端 | `npm run lint --prefix frontend`、`npm run typecheck --prefix frontend`、`npm test --prefix frontend`、`npm run build --prefix frontend` |
| 公开 SSR | `npm run test:public --prefix frontend`、`npm run build:public --prefix frontend` |
| 后端业务/权限 | `bash backend/tests/run_integration.sh` |
| 数据迁移 | `bash backend/tests/migration_smoke.sh`；PB 版本升级另跑 `pocketbase_upgrade.sh`，见后端测试手册 |
| 端到端 | `npm test --prefix e2e`，首次准备见 [E2E 手册](../e2e/README.md) |
| MCP | `npm ci --prefix mcp`、`npm test --prefix mcp` |
| 部署配置/备份 | `node deploy/verify-release-config.mjs`、`node --test deploy/*.test.mjs backend/tests/*.test.mjs`、`python3 -m unittest discover -s deploy -p 'test_*.py'`；镜像变更另跑相应 Docker smoke |
| 文档 | 相对链接/锚点、命令与当前配置核对、`git diff --check` |

CI 的实际 jobs 见 `.github/workflows/ci.yml`（前端、迁移/部署配置、后端集成、依赖审计、MCP 安装、backup/public-web Docker smoke），E2E 单独在 `e2e.yml`。`scripts/t7-release-acceptance.sh` 是部分检查的统一入口，需要已安装依赖及 OSV-Scanner；它不替代全部 CI jobs。

## 10. 部署与运维入口

[部署手册](../deploy/README.md)负责配置、固定 SHA 发布、四服务拓扑及排障；[备份恢复手册](../deploy/backup-recovery.md)负责一致性副本、隔离恢复和告警。不要在本地拿真实库执行测试。

Deploy 只接受同一完整 SHA 的成功 main push CI，先构建和预检、执行旧运行时一致性备份与卷权限准备，才快进生产目录并切换镜像，随后核对 revision、健康和公开网页。它不自动等待单独 E2E，也不自动回滚；旧 SHA 通常不满足快进约束，不能直接重放旧 SHA 当作回滚。故障处理须匹配代码、数据库、HMAC key 与网关配置。

本机默认仅保留最近 2 份成功备份，调度器每天北京时间 02:00 执行，部署前后也可能生成备份；份数不是天数。异地备份暂缓，待明确目的地后按 [offsite-backup.md](../deploy/offsite-backup.md)配置和实际恢复验收。

## 11. 红线速查（改代码前必读）

1. schema 变更只能经 `pb_migrations/`，禁止在生产 admin UI 手改结构。
2. 业务规则只写在 `pb_hooks/` 与 API rules；前端校验仅是体验层。
3. 无硬删除：停用/归档/作废/撤销用 status 表达，任何集合不开 delete。
4. 机构隔离在服务端强制：自定义端点内 organization_id 由服务端注入，放行的直连 create 由客户端传本机构值并经 API rules 校验；跨机构 404；新增带 organization_id 的接口必须同 PR 补越权测试。
5. 敏感数据导出只看 `is_sensitive` 标记位，禁止字段名启发式。
6. 审计与业务写同事务；metadata 不含密码/完整敏感答案。
7. hooks 使用 JSVM 与 `$os.getenv()`；改 `lib/` 契约必须同步全部内联副本。
8. 集成测试避免耗尽内置认证限流预算；新增套件保留 runner 的隔离与执行顺序约束。
9. Realtime payload 不承载权威指标；事件只使快照失效，最终数值必须重新读取服务端同快照汇总。
10. 环境差异走环境变量：`.env.example` 入库，真实 `.env` 与 secrets 不入库。
11. 业务口径见 [business-rules.md](business-rules.md)；改变已确认规则时先确认需求，再同 PR 更新契约与测试。

---

*本文随代码同步维护：改了本文涉及的机制（目录结构、端点清单、状态机、约定），请同 PR 更新本文。*
