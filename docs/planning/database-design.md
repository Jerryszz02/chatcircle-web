# Chat Circles — 数据库设计（PocketBase 集合设计草案）

> **2026-08-29 T1/T3 更新：**`participant_accounts` 已增加隐藏手机号/HMAC、验证时间、绑定来源和迁移状态，并新增内部 `participant_phone_challenges` 集合；存量账号已回填 `legacy_unbound`。T3 在兼容当前 schema 的前提下新增事务快照与 Realtime 守卫。现场编号、`activity_pairs`、标准报名字段激活和细粒度 `export_jobs.scope_json` 仍为`计划中`。

> 本文档将 PRD v0.3 §9 数据模型落地为 PocketBase 集合定义，面向后续实现工程师。阅读本文不需要先读 PRD；涉及 PRD 口径处均注明出处。所有表结构为**设计草案**：字段名、枚举机器码、索引与规则如与实现阶段证据冲突，以实现阶段评审结论为准并回写本文。

## 1. 文档目的

- 给出 PRD §9.1 全部 19 个集合的 PocketBase collection 定义草案；实现期又增加培训三集合、reports、posts，以及 T1 内部 `participant_phone_challenges`，当前合计 25 个业务/内部集合。
- 固化标识规则（`participant_id` 全平台稳定、`registration_id` 参与者×活动唯一、`question_code` 稳定性、`group_tag` 预留）。
- 定义多机构隔离在 PocketBase 层面的实现方式：`organization_id` 冗余字段 + API Rules 服务端强制过滤。
- 汇总全部状态枚举与状态机（活动 7 态、报名 4 态及迁移矩阵、签到场次/记录、问卷 5 态、答卷 3 态、邀请码 4 态、培训 3 态及培训签到场次/记录），并给出事务与并发约束。
- 明确迁移策略（`pb_migrations` 版本化、模板版本不可变、无硬删除）与保留策略（审计 ≥1 年、备份 30 天）。

## 2. 适用范围

- 适用：M0~M5 全部后端数据结构设计；PocketBase 集合、API Rules、迁移脚本、导出与看板的数据来源口径。
- 不适用：前端组件设计、API 路由契约（见 technical-design.md）、审计事件内容清单与隐私文案（见 security-privacy.md）、测试用例（见 test-plan.md）。
- 环境基线：PocketBase（内嵌 SQLite）单库部署，Docker 卷持久化（PRD §12.1）。

## 3. Plan 或项目证据

| 证据 | 内容 |
|---|---|
| 需求基线 | PRD v0.3（评审修订版，2026-08-05），`docs/Chat_Circles_活动与问卷平台_PRD_v0.3.docx`；本文引用其 §9 数据模型、§4 状态模型、§6 功能需求、§10 导出规范、§11 安全审计、§12.3 备份、§14 验收标准、附录 B 命名规范 |
| 已确认技术决策 | 响应式 Web（React 18 + Vite + TypeScript）+ PocketBase（后端/认证/SQLite）+ Docker；统一入口 `chatcircle.empact.cn`；完整 V1（M0~M5） |
| 项目现状（2026-08-28） | `origin/main@54de5e8` 已有 PocketBase 迁移、hooks、前端、测试、部署配置与 T0 冻结契约；当前 T3 分支仍无 `activity_pairs`，参与者 identity 仍为 `username` |
| T0 证据 | PocketBase 0.28.4 隔离临时库实测已确认自定义 text identity 可登录且唯一索引生效；为保持“只有短信验证码”的产品语义，目标方案不把手机号加入 password identity |
| 相关文档 | [README.md](README.md)（项目索引与术语）、[api-design.md](api-design.md)（T0 端点/权限/兼容契约）、technical-design.md（架构决策）、security-privacy.md（审计与隐私细则） |

## 4. 非目标

- T0 已定义 `FULL_NAME/GENDER/AGE_RANGE` 三个标准字段；本文不定义额外标准字段或自定义字段内容。知情文案见专项 PRD §8，最终法律意见仍不属于本设计。
- 不定义标准问卷模板的完整题目与锁定题清单——结构按 `survey_template_versions` + `locked` 实现，内容待模板确认（PRD §16.2）。
- 原 V1 不设计账号找回/多账号合并、统计分析/LLM/自动报告和独立域名 host 映射。2026-08-27 专项升级仅新增手机号绑定冲突的人工处理边界和运营聚合指标，不新增敏感个体画像或 LLM 自动分析。
- 不提供任何硬删除能力对应的物理删除方案（FR-AUD-001）。
- 不承诺 PocketBase 规则语法逐字可执行——规则表达式为示意，实现阶段以所选用 PocketBase 版本文档为准。

## 5. 实现指引

### 5.1 总体约定

| 约定 | 决策草案 | 依据/说明 |
|---|---|---|
| 超级管理员载体 | 使用 PocketBase 内置 `_superusers`（全平台仅一个账号，建站时创建；V1 无产品界面管理） | PRD §3、FR-AUTH-009；`_superusers` 天然绕过集合 API Rules，满足全局数据权限 |
| 管理员/参与者载体 | `admin_accounts`、`participant_accounts` 均为 PocketBase **auth 集合**（用户名+密码认证，密码哈希由 PocketBase 处理） | 满足 FR-AUTH-004（不可逆哈希、无明文）；参与者会话 30 天由 token 有效期配置实现（FR-AUTH-006） |
| 其余集合 | 均为 **base 集合** | — |
| 主键 | 一律使用 PocketBase 系统生成随机 `id`（15 位）作为业务标识（`participant_id`、`activity_id`、`registration_id` 等），满足附录 B「系统随机生成、不含身份字段」；附录 B 中的 `pt_`/`act_` 等前缀示例为可选展示形式，不作为存储要求 | PRD 附录 B |
| 系统字段 | 每个集合自带 `created`/`updated`；业务时间字段（如 `submitted_at`）显式另存 | 审计口径要求精确操作时间（FR-AUD-002） |
| 用户名唯一性 | `participant_accounts.username` 全局唯一且**字母不区分大小写**：存储时归一化为小写并建唯一索引；注册校验规则 4–20 位、仅字母/数字/下划线 | FR-AUTH-005；PocketBase 唯一约束本身区分大小写，需应用层归一化 |
| 枚举机器码 | PRD 只定义中文状态名；本文 `select` 枚举值为**草案建议机器码**，入库后不得改值，只允许追加 | PRD §4 |
| 命名 | 集合名、字段名用 snake_case；可读代码（`activity_code`、`survey_code`、`question_code` 等）遵循附录 B 规则 | PRD 附录 B |
| 时间格式 | 数据库存储 PocketBase 日期类型；导出统一 ISO 8601 并明确时区（PRD §10.3） | — |

### 5.2 集合定义草案

通用说明：

- 「必填」指创建时 PocketBase 字段级 `required`。
- 「唯一」指唯一索引（单列或复合）；「索引」指普通查询索引。
- 每张表的「API Rules 要点」只写该集合特有部分，统一隔离模式见 §5.4。
- 无任何业务集合开放 deleteRule（无硬删除，见 §5.7）。

#### 5.2.1 organizations — 机构主数据与机构级开关（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| name | text | 是 | — | 机构名称 |
| status | select(active, disabled) | 是 | 索引 | 停用后其管理员不能进入业务后台，历史数据保留（FR-ORG-001） |
| require_activity_approval | bool | 是 | — | 活动发布需平台审核开关（FR-ORG-004） |
| allow_sensitive_export | bool | 是 | — | 允许机构管理员敏感导出开关（FR-ORG-005） |
| remark | text | 否 | — | 内部备注 |

- API Rules 要点：管理员只读本机构记录（`@request.auth.organization_id = id`）；写操作仅 `_superusers`（V1 机构创建/配置无管理员侧入口）。
- 机构创建、停用、开关变更均写审计（FR-AUD-004）。

#### 5.2.2 admin_invites — 一次性管理员邀请码（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| organization_id | relation(organizations) | 是 | 索引 | 目标机构 |
| token_hash | text | 是 | **唯一** | 邀请码哈希；明文只展示一次，不落库（§11.2 精神） |
| status | select(unused, used, revoked, expired) | 是 | 索引 | 邀请码 4 态，见 §5.5 |
| expires_at | date | 是 | 索引 | 默认生成后 7 天，可调整（PRD §4.2） |
| used_by | relation(admin_accounts) | 否 | — | 成功注册的管理员 |
| used_at | date | 否 | — | 使用时间 |
| created_by | text | 是 | — | 操作者（超级管理员 id） |

- API Rules 要点：仅 `_superusers` 可 list/create/update；注册接口为自定义服务端逻辑（hooks），在事务内校验 `status=unused` 且 `expires_at > now`，注册成功同事务置 `used`。
- 生成/撤销/使用均写审计（FR-AUD-004）。

#### 5.2.3 admin_accounts — 机构管理员账号（auth）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| username | text（auth 内置） | 是 | **唯一**（全局） | 登录用户名 |
| email | text（auth 内置） | 否（schema 层） | **唯一** | 2026-08 后端改版起为**注册必填、登录身份之一**（PB 原生 `verified` 语义）；schema 层保持 optional 以兼容存量测试账号（email 为空串），必填约束由 admin-register hook 强制 |
| organization_id | relation(organizations) | 是 | 索引 | 所属机构；**参与者账号无此字段**，这是管理员与参与者集合的关键差异（FR-AUTH-003） |
| status | select(active, disabled) | 是 | — | 机构停用或账号停用时禁止进入后台 |
| display_name | text | 否 | — | 后台显示名 |

- 邮箱认证（2026-08 后端改版）：`passwordAuth.identityFields = ['username', 'email']`（用户名/邮箱 + 密码均可登录），并启用 PB 原生 OTP（`duration=300`，邮箱验证码登录）。注册后 `verified=false`，经 PB 内置 request-verification / confirm-verification 完成验证；**仅已验证邮箱可找回密码**（未验证账号请求重置时静默 204，不发邮件不放行，防账号枚举）；OTP 认证成功即证明邮箱所有权，账号同步置 `verified=true`。端点契约与限流见 technical-design §5.4「管理员邮箱认证」。
- 换邮箱走 PB 内置 requestEmailChange 流程；直连 update 修改 `email` 由 guards.pb.js 禁止（加入禁改清单）。
- 当前代码基线中 `participant_accounts` 不存邮箱/手机号；2026-08-27 专项升级将新增已验证手机号，迁移与最小暴露规则见 [account-event-workflow-prd.md](account-event-workflow-prd.md) §3、§9。
- API Rules 要点：管理员只能 view 本机构同事记录与本人记录；create 仅经邀请码注册接口（服务端）；不允许管理员修改 `organization_id`。
- 机构 `status=disabled` 时由服务端钩子拒绝其全部管理操作（FR-ORG-001）。

#### 5.2.4 participant_accounts — 全平台通用参与者账号（auth）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| username | text（auth 内置） | 是 | **唯一**（小写归一化后） | 4–20 位字母/数字/下划线；不绑定任何机构（FR-AUTH-003、FR-AUTH-005） |
| status | select(active, disabled) | 是 | — | 账号停用为可审计事件（PRD §11.3） |
| （created） | 系统字段 | — | 索引 | 即 PRD §9.1 的 `created_at`；跨活动账号连续性统计可用 |

- **当前实现**不存手机号、邮箱、微信等联系方式；**目标状态**新增已验证手机号作为主要登录身份，保留 `username` 仅用于存量兼容，见 [account-event-workflow-prd.md](account-event-workflow-prd.md) §3、§9。
- API Rules 要点：参与者仅能 view/update 本人记录（`@request.auth.id = id`），且不可改 `username`（机构管理员也不得修改参与者凭据，PRD §3.2）；create 仅经报名链路自动注册接口。
- 无密码重置/找回入口（任何角色，PRD §5.7）。

#### 5.2.5 activities — 活动主数据与名额（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| organization_id | relation(organizations) | 是 | 复合索引 (organization_id, status) | 机构隔离主键 |
| title | text | 是 | — | 活动标题（FR-ACT-001） |
| activity_code | text | 是 | **唯一** | 可读稳定代码，建议机构缩写+日期+序号，如 `CC_SG_202608_01`（附录 B） |
| description | text | 否 | — | 公开详情页内容 |
| location | text | 否 | — | 地点 |
| start_time / end_time | date | 是 | — | PRD §9.1 `times`；单次场次口径（§4.1） |
| status | select(draft, pending_review, rejected, published, closed, taken_down, archived) | 是 | 索引 | 活动 7 态，见 §5.5 |
| capacity_total | number | 是 | — | 总名额硬限制；须为正偶数，且不得低于当前已通过人数（FR-ACT-006） |
| capacity_speaker | number | 是 | — | 倾诉者名额；由 capacity_total 对半派生，不可单独设置 |
| capacity_listener | number | 是 | — | 聆听者名额；由 capacity_total 对半派生，不可单独设置 |
| registration_open | bool | 是 | — | 报名手动开关（FR-ACT-005） |
| registration_start_at / registration_end_at | date | 否 | — | 报名起止时间；超时后不能新提交（FR-ACT-005） |
| checkin_qr_token | text | 是 | **唯一** | 固定签到二维码 token；全活动周期不变（FR-CHK-001），有效性由 `checkin_sessions` 开放状态控制 |
| group_tag | text | 否 | 索引 | **预留分组/标签字段（可空）**，V1 不使用，供后续「项目/系列」扩展（PRD §4.1） |
| form_config_json | json | 否 | — | 草案：活动级报名字段启用/必填配置（见「待确认」D-3） |

- API Rules 要点：**公开详情页**通过 viewRule 实现——未登录可按 id 查看 `status` 为 `published`/`closed` 的活动；listRule 对参与者保持关闭，公开列表不走集合 API，而由 hook 端点 `GET /api/cc/public/activities` 提供（活动广场页 `/activities`，仅下发 `published`/`closed`，按开始时间倒序；系对 FR-ACT-002「无公开广场」的实现期偏离，初随首页落地，后拆为独立页）。已归档活动公开链接是否仍可访问 PRD 未明确（「待确认」D-5）。
- 名额修改、状态变更写审计（PRD §11.3）。

#### 5.2.6 activity_approvals — 活动发布审核历史（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| activity_id | relation(activities) | 是 | 索引 | 目标活动 |
| reviewer_id | text | 是 | — | 审核人（超级管理员 id）；提交动作时为提交的管理员 id |
| action | select(submit, approve, reject) | 是 | — | 提交/批准/驳回；**下架不经过本表**，直接改活动状态并写审计 |
| reason | text | 否 | — | 驳回必填原因（机构可查看原因后修改重提，PRD §4.3） |
| （created） | 系统字段 | — | — | 即 `created_at` |

- 只追加不修改（历史表）；API Rules：机构管理员只读本机构活动的审核记录，超级管理员全量。

#### 5.2.7 registration_field_defs — 报名字段定义（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| organization_id | relation(organizations) | 否 | 索引 | **null = 平台标准字段**（超级管理员维护）；非 null = 机构自定义字段（PRD §8.1） |
| field_code | text | 是 | **复合唯一 (organization_id, field_code)**；索引 | 稳定机器代码；标准字段代码不可改（FR-REG-001） |
| field_type | select(text, number, single_choice, multi_choice, date) | 是 | — | 草案题型集，随标准字段定义确认后定稿 |
| label | text | 是 | — | 展示文案 |
| source_type | select(standard, custom) | 是 | 索引 | 导出 `custom_fields.csv` 单独标记自定义内容（PRD §2.3、§10.1） |
| is_sensitive | bool | 是 | — | **敏感标记；普通导出按此排除/掩码，不依赖字段名判断**（FR-EXP-002） |
| options_json | json | 否 | — | 选项机器值与显示文本 |
| required_default | bool | 是 | — | 默认必填建议；活动级覆盖见 `activities.form_config_json` |
| role_scope | select(both, speaker, listener) | 否 | — | 适用角色（分角色报名问卷，2026-08 扩展）：both=两角色通用。select 无 schema 级默认值，存量行已回填 both；hooks 读取侧对空值按 both 归一兜底 |
| status | select(active, disabled) | 是 | — | 停用代替删除 |

- 标准字段（`organization_id IS NULL`）仅 `_superusers` 可写；机构只能选启用/必填，不能改代码与类型（PRD §8.1）。
- 报名校验按 `activity_role` 过滤适用字段（`role_scope ∈ {both, 该角色}`）：必填与格式校验仅针对适用字段；对不适用字段提交答案报 `field_not_applicable`（registrations.pb.js）。机构自定义字段的 `role_scope` 机构可编辑；平台标准字段的 `role_scope` 由超管维护（同标准字段既有维护方式）。
- 具体标准字段清单 PRD 未写死 → 「待确认」D-1。

#### 5.2.8 registrations — 报名、角色与审核状态（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| activity_id | relation(activities) | 是 | **复合唯一 (activity_id, participant_id)**；复合索引 (activity_id, status) | 报名归属 |
| participant_id | relation(participant_accounts) | 是 | 索引 | 报名人；「我的」中心按此查本人全部报名（FR-PAR-001） |
| activity_role | select(speaker, listener) | 是 | 索引 | **活动内角色存于报名，不写入账号**（FR-REG-002）；倾诉者=speaker、聆听者=listener |
| status | select(pending, approved, rejected, cancelled) | 是 | 索引 | 报名 4 态与迁移矩阵，见 §5.5 |
| submitted_at | date | 是 | — | 提交时间（幂等判定的参考字段之一，AC-20） |
| status_reason | text | 否 | — | 最近一次状态变更原因（取消/回退必填，FR-REG-008）；完整历史在 audit_logs |

- **参与者×活动唯一**：复合唯一索引保证同一参与者同一活动仅一条报名记录（FR-REG-003）；重复进入由应用层返回现有状态而非新建。
- API Rules 要点：参与者只能 create（且服务端强制写入本人 `participant_id`）与 view 本人记录；**不允许参与者 update**（提交后不可改，FR-REG-004）；管理员按机构隔离读写。
- 所有状态变更走服务端事务（名额硬校验 + 审计），见 §5.6。

#### 5.2.9 registration_answers — 报名字段答案（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| registration_id | relation(registrations) | 是 | **复合唯一 (registration_id, field_def_id)** | 所属报名 |
| field_def_id | relation(registration_field_defs) | 是 | 索引 | 答案对应的字段定义（`is_sensitive` 由此反查） |
| value_json | json | 是 | — | 答案值；多选用标准 JSON 数组（PRD §10.3） |

- API Rules 要点：参与者随报名创建写入，之后只读；管理员按机构隔离（经 `registration_id.activity_id.organization_id` 反查，规则中需保证可可靠反查，PRD §9.2）。
- 日志不得记录完整敏感答案（PRD §11.2）。

#### 5.2.10 checkin_sessions — 签到开放状态（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| activity_id | relation(activities) | 是 | 复合索引 (activity_id, status) | 所属活动 |
| status | select(open, closed) | 是 | — | 「未开放」不建行：活动无 open session 即为未开放；每次「开放签到」新建一行，关闭时置 `closed`（签到可重复开放/关闭，PRD §5.5） |
| opened_at | date | 是 | — | 开放时间 |
| closed_at | date | 否 | — | 关闭时间 |
| opened_by | text | 是 | — | 操作管理员 id |

- **约束：同一活动同一时间至多一条 `open` 记录**（服务端事务保证）。
- 固定二维码 token 在 `activities.checkin_qr_token`；本表只表达开放窗口（FR-CHK-001、FR-CHK-002）。
- 开放/关闭写审计（PRD §11.3）。

#### 5.2.11 checkins — 签到记录（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| activity_id | relation(activities) | 是 | 复合索引 (activity_id, participant_id, status) | 所属活动 |
| participant_id | relation(participant_accounts) | 是 | 索引 | 签到人 |
| registration_id | relation(registrations) | 是 | — | 关联报名（签到前置：报名状态=approved，FR-CHK-003） |
| source | select(self_scan, manual) | 是 | — | 自助扫码 / 管理员补签 |
| status | select(valid, revoked) | 是 | 索引 | 「已撤销」保留原记录（PRD §4.5）；「未签到」不建行 |
| checked_in_at | date | 是 | — | 签到时间 |
| operator_id | text | 否 | — | 补签/撤销操作管理员 id；自助签到为空 |
| reason | text | 否 | — | 补签/撤销必填原因（FR-CHK-005） |
| revoked_at | date | 否 | — | 撤销时间 |

- **「每活动每人仅一条有效签到」无法在 SQLite 表达部分唯一索引**（撤销行需保留）：由服务端 hooks 事务校验 + 上述复合索引支撑查询（FR-CHK-004、AC-09、AC-20）；不得以 (activity_id, participant_id) 全量唯一索引实现，否则撤销后无法补签。
- 实际参与人数/服务人次口径 = `status=valid` 记录数（FR-CHK-006、§7.1）；看板与导出共用此口径。

#### 5.2.12 survey_templates — 标准模板索引（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| template_code | text | 是 | **唯一** | 大写下划线，如 `PARTICIPANT_PRE_V1`（附录 B） |
| name | text | 是 | — | 模板名称 |
| description | text | 否 | — | 用途说明 |
| current_version_id | relation(survey_template_versions) | 是 | — | 指向当前生效版本；复制活动问卷时取此版本（FR-SUR-011） |
| status | select(active, disabled) | 是 | — | 停用代替删除 |

- 仅 `_superusers` 可写（FR-SUR-001）；机构只读。

#### 5.2.13 survey_template_versions — 不可变模板版本（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| template_id | relation(survey_templates) | 是 | **复合唯一 (template_id, version)** | 所属模板 |
| version | number | 是 | — | 递增整数版本号 |
| schema_json | json | 是 | — | 题目完整定义快照（含 question_code、题型、选项、locked、is_sensitive、计分定义） |
| published_at | date | 是 | — | 发布时间 |
| published_by | text | 是 | — | 发布的超级管理员 id |

- **不可变**：发布后 update/delete 均禁止（API Rules 关闭，服务端无入口）；模板更新 = 新增版本行 + 移动 `current_version_id`，已有活动问卷固定原版本（FR-SUR-011、AC-13、PRD §13 可维护性）。
- 模板发布写审计（PRD §11.3）。

#### 5.2.14 activity_surveys — 活动问卷与独立入口（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| activity_id | relation(activities) | 是 | 复合索引 (activity_id, status) | 所属活动；一场活动可多份问卷（FR-SUR-003） |
| template_version_id | relation(survey_template_versions) | 是 | — | 来源模板版本（复制创建；创建后不再随模板升级） |
| survey_code | text | 是 | **唯一** | 活动问卷稳定代码，如 `CC_SG_202608_01_PRE`（附录 B） |
| title | text | 是 | — | 问卷标题 |
| role_scope | select(speaker, listener, both) | 是 | — | 适用角色；访问时按报名 `activity_role` 校验（FR-SUR-004） |
| status | select(draft, not_open, open, ended, archived) | 是 | 索引 | 问卷 5 态（未开放/开放中/已结束 + 草稿/已归档），见 §5.5 |
| qr_token | text | 是 | **唯一** | 独立链接/二维码 token；不可连续可猜（PRD §10.3 同类要求） |
| opened_at / ended_at | date | 否 | — | 开放/结束时间（管理员手动控制，不由签到或时间点自动强制，PRD §8.2） |

- API Rules 要点：参与者经自定义接口按「登录 + 报名已通过 + 角色匹配 + 状态=open」四条件访问（FR-SUR-006）；不开放参与者直接 list 本表。
- 开放/结束写审计（PRD §11.3）。

#### 5.2.15 survey_questions — 活动问卷题目（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| activity_survey_id | relation(activity_surveys) | 是 | **复合唯一 (activity_survey_id, question_code)** | 所属问卷 |
| question_code | text | 是 | 索引 | **稳定机器字段：标准题跨模板/跨活动保持一致；自定义题活动内唯一**，前缀如 `CUS_ORG7_001`（§8.3、附录 B） |
| source_type | select(standard, custom) | 是 | — | standard=模板核心题；custom=机构新增题 |
| question_type | select(info, single_choice, multi_choice, scale_1_5, scale_0_10, text_short, text_long) | 是 | — | 说明/单选/多选/1-5/0-10/单行/多行（FR-SUR-007） |
| title | text | 是 | — | 题干 |
| required | bool | 是 | — | 机构可对非锁定题调整（FR-SUR-002） |
| options_json | json | 否 | — | 选项机器值与显示文本 |
| locked | bool | 是 | — | 核心锁定题：机构不能修改或删除（FR-SUR-001） |
| is_sensitive | bool | 是 | — | 敏感标记；普通导出过滤依据，进入 data_dictionary（FR-SUR-012） |
| order_index | number | 是 | — | 显示顺序 |
| validation_json | json | 否 | — | 范围、长度等校验（如 `min=1,max=5`） |

- 复制模板 = 将 `schema_json` 中题目物化为本表行（复制后题目随活动问卷固化，模板升级不影响，AC-13）。
- 机构可新增/排序/设必填自定义题；`locked=true` 行对机构只读（FR-SUR-002）。

#### 5.2.16 submissions — 答卷（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| activity_survey_id | relation(activity_surveys) | 是 | **复合唯一 (activity_survey_id, participant_id)**；复合索引 (activity_survey_id, status) | 所属问卷 |
| participant_id | relation(participant_accounts) | 是 | 索引 | 答卷人 |
| registration_id | relation(registrations) | 是 | 索引 | 关联报名（同一活动多份问卷可经此关联，PRD §1.3 数据连续性） |
| status | select(draft, submitted, voided) | 是 | 索引 | 草稿/已提交/已作废 3 态；V1 无退回重填（PRD §4.5、§5.6） |
| submitted_at | date | 否 | — | 正式提交时间；草稿为空 |
| voided_by / voided_at / void_reason | text / date / text | 否 | — | 作废操作信息（FR-SUR-010） |

- 一人一问卷一份答卷：草稿到正式提交是**同一行的状态变更**，不产生第二行（FR-SUR-008、AC-20 幂等）；作废后原记录保留，V1 不支持重填，故复合唯一索引安全。
- API Rules 要点：参与者 create/update 仅限本人 `draft` 行；提交后锁定（服务端拒绝再改）；本人已提交答案只读（FR-SUR-009）；作废仅管理员（服务端接口，写审计）。
- 问卷完成数口径 = `status=submitted` 且未作废；总体完成率的分子只统计当前报名仍为 approved 且角色符合者的有效提交，分母使用同一当前资格集合。报名取消/回退后须同时移出分子和分母，分母为 0 时返回 null，比例不得超过 1（PRD §7.1；专项现场口径见 account-event-workflow-prd.md §4.3）。

#### 5.2.17 answers — 题目答案（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| submission_id | relation(submissions) | 是 | **复合唯一 (submission_id, question_code)** | 所属答卷 |
| question_code | text | 是 | 复合索引 (question_code) | 冗余存储题目代码：**导出 answers.csv 直接按 question_code 关联，且保证历史答案不受题目后续调整影响**（PRD §9.2） |
| value_json | json | 是 | — | 答案值；多选用标准 JSON 数组（PRD §10.3） |

- 随提交事务写入；`is_sensitive` 由 `survey_questions` 按 `question_code` 反查（导出过滤，FR-EXP-002）。

#### 5.2.18 export_jobs — 导出任务与文件（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| organization_id | relation(organizations) | 否 | 索引 | 导出主机构；超级管理员全平台导出时为 null |
| scope_json | json | 是 | — | 导出范围：`{type: platform\|organization\|activity, activity_id?, date_range?}`；范围校验在服务端执行（FR-EXP-004） |
| include_pii | bool | 是 | 索引 | 是否敏感导出；为 true 时需机构开关 + 二次确认 + 审计（FR-EXP-003、AC-17） |
| file_path | text | 是 | — | ZIP 存放路径（受保护目录，仅鉴权后下载，PRD §11.2） |
| file_checksum | text | 否 | — | 文件校验信息（PRD §10.3） |
| status | select(running, done, failed) | 是 | — | 任务状态 |
| created_by | text | 是 | 索引 | 导出人 id（导出记录需保留导出人/范围/时间，PRD §10.3） |

- 导出文件不自动失效；下载 URL 不公开、不连续可猜（FR-EXP-005）。
- 每次导出（普通/敏感）均写审计（PRD §11.3）。

#### 5.2.19 audit_logs — 不可变审计记录（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| actor_id | text | 是 | 复合索引 (actor_id, created) | 操作者 id；系统任务（备份）用 `system` |
| actor_role | select(super_admin, admin, participant, system) | 是 | — | 操作者角色 |
| organization_id | relation(organizations) | 否 | 复合索引 (organization_id, created) | 涉事机构；平台级事件可为 null |
| action | text | 是 | 索引 | 动作代码（如 `registration.status_revert`、`export.sensitive`、`backup.failed`）；枚举清单见 security-privacy.md，范围至少覆盖 FR-AUD-004 |
| target_type / target_id | text | 是 | 索引 (target_type, target_id) | 被操作对象 |
| result | select(success, failure) | 是 | — | 操作结果（FR-AUD-002 要求记录结果） |
| reason | text | 否 | — | 高风险操作原因（补签/回退/作废等必填） |
| metadata | json | 否 | — | 前后状态、上下文；**不得含密码或完整敏感答案**（PRD §11.2） |
| （created） | 系统字段 | — | 索引 | 即 `created_at` |

- **不可变**：仅开放 create（服务端）与按权限 view；update/delete 规则全部关闭，普通管理员不可修改（FR-AUD-002、FR-AUD-005）。
- 可读权限：机构管理员只读检索本机构（`organization_id` 过滤），超级管理员全局（FR-AUD-005）。
- 保留 ≥1 年（FR-AUD-003），到期策略后续治理决定。

#### 5.2.20 trainings — 聆听者培训主数据（base，2026-08 PRD 外扩展）

> 培训体系为 PRD v0.3 之外的实现期扩展（迁移 `1785889320_cc_role_scope_trainings.js`）：培训与活动解绑；培训机构级创建，而签到资格与「培训通过」标记为账号级、全平台通用。

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| organization_id | relation(organizations) | 是 | 复合索引 (organization_id, status) | 机构隔离主键 |
| title | text | 是 | — | 培训标题 |
| training_code | text | 是 | **唯一** | 可读稳定代码，约定同 `activities.activity_code` |
| description | text | 否 | — | 培训说明 |
| location | text | 否 | — | 地点 |
| start_time / end_time | date | 否 | — | 培训起止时间 |
| status | select(draft, published, closed) | 是 | 索引 | 培训 3 态，见 §5.5；状态流转只走 hooks 端点 |
| checkin_qr_token | text | 否 | **唯一** | 固定签到二维码 token；**服务端 onRecordCreate 生成 24 位随机 token**（同 activities 加固做法），客户端传入一律忽略 |

- API Rules 镜像 activities：机构管理员按本机构读写（`@request.auth.organization_id = organization_id`），超管全量；**参与者/匿名不可直读**——培训信息仅经白名单端点 `GET /api/cc/me/trainings` 按资格下发；deleteRule 关闭（无硬删除）。
- 直连守卫（guards.pb.js）：创建强制 `status='draft'`；禁直连改 `status` / `organization_id` / `checkin_qr_token`。
- 发布/关闭与签到开放/关闭均写审计（`training.publish` / `training.close` / `training.checkin_open` / `training.checkin_close`）。

#### 5.2.21 training_checkin_sessions — 培训签到开放窗口（base）

语义镜像 checkin_sessions（§5.2.10）：

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| training_id | relation(trainings) | 是 | 复合索引 (training_id, status) | 所属培训 |
| status | select(open, closed) | 是 | — | 「未开放」不建行；每次开放新建一行，关闭时置 closed |
| opened_at | date | 是 | — | 开放时间 |
| closed_at | date | 否 | — | 关闭时间 |
| opened_by | text | 是 | — | 操作管理员 id |

- **同一培训同一时间至多一条 open 记录**（hooks 事务保证）。
- API Rules：管理员经 `training_id.organization_id` 按机构隔离读写；**直连写由 guards.pb.js 全锁**（开放/关闭只走 `/api/cc/trainings/{id}/checkin/open|close` 端点）；deleteRule 关闭。

#### 5.2.22 training_attendances — 培训签到记录（base）

语义镜像 checkins（§5.2.11）：

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| training_id | relation(trainings) | 是 | 复合索引 (training_id, participant_id, status) | 所属培训 |
| participant_id | relation(participant_accounts) | 是 | 索引 | 签到人 |
| source | select(self_scan, manual) | 是 | — | 自助扫码 / 管理员补签 |
| status | select(valid, revoked) | 是 | 索引 | 「已撤销」保留原记录；「未签到」不建行 |
| checked_in_at | date | 是 | — | 签到时间 |
| operator_id | text | 否 | — | 补签/撤销操作管理员 id；自助签到为空 |
| reason | text | 否 | — | 补签/撤销必填原因（hooks 校验） |
| revoked_at | date | 否 | — | 撤销时间 |

- **每人每培训至多一条 valid**：SQLite 无法表达部分唯一索引，由 hooks 事务查重保证；不建 (training_id, participant_id) 全量唯一索引（否则撤销后无法重签）。
- **「培训通过」账号级口径 = 存在任一 valid 出席记录**（全平台通用）；当前仅作记录与展示，不作为报名门槛（2026-08 决策）。
- 签到前置：登录 + 存在 approved 的聆听者报名（全平台任一活动，资格账号级通用，否则 403 `listener_not_approved`）+ 培训 published + 签到开放中。
- API Rules：管理员按机构隔离只读，参与者只读本人记录；**直连写全锁**（只走 hooks 端点），deleteRule 关闭。

#### 5.2.23 reports — 活动数据报告（base）

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| title | text | 是 | — | 报告标题 |
| activity_id | relation(activities) | 否 | 索引 | 所属活动；可空为未来机构/平台级报告留口 |
| file | file | 是 | maxSelect=1、maxSize=20MB、protected | 报告文件（pdf/md 等）；protected：文件 URL 须带 token，不走公开静态路径（同导出文件防护口径，PRD §11.2） |
| status | select(draft, published) | 是 | 索引 | agent 上传一律 draft，人工审核后改 published |
| export_job_id | text | 否 | — | 溯源：本报告基于哪次导出（`export_jobs.id`） |
| notes | text | 否 | — | 生成元信息（分析 skill / prompt 版本等） |
| created_by | text | 否 | — | 创建人 id，由 `reports.pb.js` 的 onRecordCreateRequest 强制填充（忽略客户端传入，同 export_jobs.created_by 约定） |

- 背景：数据分析与报告生成由外部 agent 完成（经 `mcp/` MCP server 以超管服务账号接入）；取数仍走 `POST /api/cc/exports`，本集合只做产出物存储。
- API Rules 全部 null：仅超级管理员经 API / admin UI 可读写；agent 通道上传强制 draft，发布保留人工。
- 创建审计（`report.upload`）由 `reports.pb.js` 的 onRecordCreate 模型钩子与报告保存在**同一事务**写入（失败即整体回滚），机构归属经 `activity_id` 反查。
- guards.pb.js 未为本集合加直连写守卫：rules 全 null 时非超管在 rule 层已被拒，守卫无额外收窄对象（守卫针对「规则放行但需收窄」的场景）。

#### 5.2.24 posts — 内容推文（base，2026-08 后端改版，PRD 外扩展）

> 内容推文为 2026-08 后端改版新增的**独立模块，与 activities 完全无关**；仅超管可编辑（机构管理员无入口），公开端仅见 `visible`。推文上不挂手填活动成果数据——首页成效由公开端点 `GET /api/cc/public/outcome` 自动聚合（见 technical-design §5.6）。

| 字段 | 类型 | 必填 | 约束/索引 | 说明 |
|---|---|---|---|---|
| title | text | 是 | — | 推文标题 |
| summary | text | 否 | — | 摘要；为空时前端摘取正文前 N 字兜底 |
| cover | file | 否 | maxSelect=1、maxSize=5MB、mimeTypes 限 image/* | 封面图（单图；5MB 为暂定值，见「待确认」D-9）；文件 URL 随 viewRule 放行 |
| body_md | text | 否 | — | Markdown 原文；**消毒在渲染端**（服务端只存原文，前端渲染时消毒） |
| external_url | text | 否 | — | 外链 URL；非空时仅允许 http/https（hooks 校验 `^https?://`） |
| is_pinned | bool | 否 | 复合索引 (is_pinned, published_at) | 置顶开关（bool 一律 required=false，同现有迁移约定） |
| status | select(hidden, visible) | 是 | 索引；默认 hidden | 可见性开关；隐藏即删除（无硬删除） |
| published_at | date | 否 | 复合索引 (is_pinned, published_at) | 首次置 visible 时由 hook 写入当前时间，之后不因隐藏/再可见而改 |
| created_by / updated_by | text | 否 | hidden=true（仅超管可见） | 归因字段：服务端钩子强制填充（客户端传入无效），供审计 actor（同 reports.created_by 约定）；创建/更新审计与推文保存在同一事务写入（同 reports.pb.js 模式） |

- **约束：正文（`body_md`）与外链（`external_url`）至少填一个**，全空由 posts.pb.js 校验拒绝（400）。
- API Rules：listRule / viewRule = `status = 'visible' || @request.auth.collectionName = '_superusers'`（匿名/参与者/机构管理员仅见 visible；超管全见）；createRule / updateRule 仅 `_superusers`；deleteRule 关闭（隐藏即删除，见 §5.7）。
- 公开读直接走集合 API，不新增公开读 hook：`GET /api/collections/posts/records?sort=-is_pinned,-published_at`，rule 天然过滤 hidden。
- `status` 首次变为 visible 且 `published_at` 为空时，由 hooks 写入当前时间；创建/更新写审计（`post.create` / `post.update`，metadata 带 status 迁移）。
- 实施前置验证点：先以探针确认匿名请求下 `@request.auth.collectionName` 规则求值行为符合预期（匿名时右侧整体为假）。

### 5.3 标识与关联规则

| 标识 | 载体 | 作用域与稳定性 | 导出规则 |
|---|---|---|---|
| `participant_id` | `participant_accounts.id` | **全平台稳定**：不随机构、活动变化；凭据丢失重新注册会产生新 id（已知情况，V1 不合并，PRD §5.7） | 普通导出的唯一人员关联键；**不导出用户名**（PRD §9.2、§10.1） |
| `organization_id` | `organizations.id` | 机构级；所有机构业务表必须带有或可经关系可靠反查（PRD §9.2） | 管理员导出仅本机构；超级管理员可全平台 |
| `activity_id` | `activities.id` | 全平台唯一 | 报名、签到、问卷、导出均可关联 |
| `registration_id` | `registrations.id` | **参与者×活动唯一**（复合唯一索引保证）；关联报名答案、角色、审核、签到、答卷 | 进入 registrations.csv / registration_answers.csv |
| `submission_id` | `submissions.id` | 一次答卷 | 进入 submissions.csv 与 answers.csv |
| `question_code` | `survey_questions.question_code` / `answers.question_code` | **标准题跨模板、跨活动稳定一致**；自定义题活动内唯一（`CUS_` 前缀） | 进入 answers.csv 与 data_dictionary.csv |
| `activity_code` / `survey_code` / `template_code` / `training_code` | 各自 text 字段 | 可读稳定代码，遵循附录 B 格式 | 人读追溯用 |
| `group_tag` | `activities.group_tag` | **预留字段（可空），V1 不使用**；供后续分组/系列/项目层级扩展，禁止 V1 占用语义 | 导出保留该列（可为空） |

外键关系主线：`organizations 1—n activities 1—n (registrations, checkin_sessions, checkins, activity_surveys)`；`activity_surveys 1—n (survey_questions, submissions)`；`submissions 1—n answers`；`registrations 1—n registration_answers`。`checkins.registration_id` 与 `submissions.registration_id` 使签到/答卷可回链审核口径。培训体系（2026-08 扩展）：`organizations 1—n trainings 1—n (training_checkin_sessions, training_attendances)`，与活动签到平行、互不引用。

### 5.4 多机构隔离在 PocketBase 层面的实现

原则：**隔离由后端规则兜底，前端隐藏只是体验层**（PRD §9.2、§12.2；AC-03 要求自动化越权测试）。

1. **数据冗余**：每个机构业务表直接存 `organization_id`（`activities` 直接带；`registrations`/`checkins`/`activity_surveys` 等经 `activity_id` 一级反查）。对查询频繁的二级表（如 `registrations`）**草案建议冗余 `organization_id` 字段**，使 API Rules 表达式保持单层、可索引；冗余字段由服务端 hooks 在创建时写入，客户端不可写。
2. **规则注入**（示意语法，以实现阶段 PocketBase 版本为准）：
   - 管理员侧 list/view：`@request.auth.organization_id = organization_id`（或经 relation 反查：`@request.auth.organization_id = activity.organization_id`）。
   - 参与者侧：`@request.auth.id = participant_id`（仅本人记录）。
   - 超级管理员：`_superusers` 身份天然绕过集合规则，无需逐表配置。
3. **参数防伪**：管理端自定义接口忽略客户端传入的任何机构参数，机构范围一律从 `@request.auth` 推导（PRD §12.2）。
4. **导出与看板**：聚合查询与导出任务在服务端按登录身份附加同一 `organization_id` 条件；`export_jobs.scope_json` 中的范围须与服务端校验后的身份交集（FR-EXP-004）。
5. **公开面最小化**：参与者对 `activities` 仅 viewRule（按 id 看详情），listRule 关闭；唯一的公开列表是 hook 端点 `GET /api/cc/public/activities`（活动广场页 `/activities`，仅 `published`/`closed`），不开放集合级 list。
6. **验证方式**：每个涉及机构数据的 list/view/export 接口必须有机构 A 访问机构 B 资源 ID 的自动化越权用例（AC-03，详见 test-plan.md）。

### 5.5 状态枚举与状态机

枚举机器码为草案建议（PRD 仅定义中文名）；迁移合法性由服务端统一校验，非法迁移一律拒绝。

| 对象 | 字段 | 枚举（机器码 = 中文） |
|---|---|---|
| 邀请码 | `admin_invites.status` | `unused`=未使用；`used`=已使用；`revoked`=已撤销；`expired`=已过期（默认 7 天，生成时可调） |
| 活动 | `activities.status` | `draft`=草稿；`pending_review`=待平台审核；`rejected`=已驳回；`published`=已发布；`closed`=已关闭；`taken_down`=已下架；`archived`=已归档 |
| 报名 | `registrations.status` | `pending`=待审核；`approved`=已通过；`rejected`=已拒绝；`cancelled`=已取消（无候补态，PRD §4.4） |
| 签到场次 | `checkin_sessions.status` | `open`=已开放；`closed`=已关闭（「未开放」= 无 open 记录） |
| 签到记录 | `checkins.status` | `valid`=已签到；`revoked`=已撤销（「未签到」= 无记录） |
| 培训 | `trainings.status` | `draft`=草稿；`published`=已发布；`closed`=已关闭（2026-08 扩展） |
| 培训签到场次 | `training_checkin_sessions.status` | `open`=已开放；`closed`=已关闭（「未开放」= 无 open 记录） |
| 培训签到记录 | `training_attendances.status` | `valid`=已签到（培训通过）；`revoked`=已撤销（「未签到」= 无记录） |
| 活动问卷 | `activity_surveys.status` | `draft`=草稿；`not_open`=未开放；`open`=开放中；`ended`=已结束；`archived`=已归档 |
| 答卷 | `submissions.status` | `draft`=草稿；`submitted`=已提交；`voided`=已作废（无退回重填） |
| 机构/账号 | `*.status` | `active` / `disabled` |

报名状态迁移矩阵（PRD §4.4，**矩阵外迁移一律禁止**）：

| 迁移 | 触发场景 | 服务端要求 |
|---|---|---|
| pending → approved | 审核通过 | 事务内校验总名额 + 角色名额；占用名额 |
| pending → rejected | 审核拒绝 | 不占名额 |
| approved → cancelled | 线下申请/运营原因 | 释放名额；**原因必填 + 审计** |
| rejected → approved | 纠正误判 | 事务内**重新**名额硬校验；原因必填 + 审计 |
| cancelled → approved | 恢复报名 | 事务内**重新**名额硬校验；原因必填 + 审计 |

其他状态机要点：

- 活动：`draft → (pending_review →) published → closed → archived`；`published → taken_down`（仅超级管理员）；`pending_review → rejected → pending_review`（修改重提）。已驳回/已下架不进入公开入口。
- 签到场次：管理员手动 `open ⇄ closed` 可重复；有效签到仍每活动每人一条。
- 培训：`draft → published → closed`，状态流转只走 hooks 端点（直连创建强制 draft、禁直连改 status）；培训签到场次 `open ⇄ closed` 可重复；有效出席每培训每人一条。
- 问卷：`draft → not_open ⇄ open → ended → archived`；开放/结束手动控制，不被签到状态或时间点强制。
- 答卷：`draft → submitted`（锁定，参与者不可再改）；`submitted → voided`（仅管理员，原因 + 审计）；作废记录常规统计与导出排除。
- 所有状态变更记录操作者、时间、前后状态与原因，写入 `audit_logs`（FR-REG-008、FR-AUD-002）。

### 5.6 事务与并发约束

| 场景 | 约束 | 实现草案 |
|---|---|---|
| 审核通过 / 角色修改 / 状态回退 | 总名额与角色名额硬限制，并发审核不得超额（AC-08） | PocketBase hooks 内单事务：锁定活动行 → 统计当前 `approved` 数（按角色）→ 比对名额 → 更新状态 → 写审计；任一失败整体回滚 |
| 名额调低 | 新名额不得低于当前已通过人数（FR-ACT-006） | 更新 `activities.capacity_*` 前同事务校验 |
| 自助签到 / 补签 | 每活动每人仅一条 `valid` 记录；重试/重复扫码幂等（AC-09、AC-20） | 事务内查重 → 插入；重复请求返回已存在的记录而非报错新建 |
| 培训自助签到 / 补签（2026-08 扩展） | 每培训每人仅一条 `valid` 记录；重复扫码/补签幂等；资格 = 存在 approved 聆听者报名 | 事务内资格校验 + 查重 → 插入；重复请求返回已有记录；SQLite 快照冲突最多重试 2 次后返回 409 |
| 报名/问卷提交 | 网络重试、重复点击不产生重复正式记录（AC-20） | 复合唯一索引兜底 + 服务端「已存在则返回现状」语义 |
| 邀请码注册 | 同一邀请码只能成功注册一次（AC-02） | 事务内校验并置 `used` |
| 答卷提交 | 草稿→已提交为原子切换，答案行随同事务写入 | 单事务更新 `submissions` + 写 `answers` |

### 5.7 迁移策略

- **版本化**：全部集合结构变更通过 `pb_migrations`（PocketBase 迁移脚本）管理，逐文件递增版本号，随仓库提交；禁止在管理 UI 手工改库后不落迁移脚本（PRD §13 可维护性、§15 M0 退出条件含「迁移」）。
- **初始化种子**：唯一超级管理员账号、标准问卷模板首个版本随迁移/初始化脚本注入（建站时创建，FR-AUTH-009）。
- **模板版本不可变**：`survey_template_versions` 发布后禁改；模板演进 = 新版本行 + 切换 `current_version_id`（AC-13）。
- **无硬删除**：所有业务集合 deleteRule 关闭；停用/归档/作废/撤销均以状态字段表达，历史关系保留（FR-AUD-001、AC-18）。产品界面与普通 API 均不提供永久删除。
- **演进纪律**：枚举值只增不改；字段下线用停用/废弃标记，不做破坏性 rename/drop（保证历史导出与 data_dictionary 可追溯）。

### 5.8 保留与备份策略（数据库相关部分）

| 项 | V1 规则 | 依据 |
|---|---|---|
| 审计日志 | 默认至少保留 **1 年**；到期策略由后续治理决定 | FR-AUD-003、§12.4 |
| 备份 | 数据库及上传文件**每日自动备份**；默认保留最近 **30 天**；至少一份在异地存储 | PRD §12.3 |
| 备份审计与告警 | 每次备份结果（成功/失败）写 `audit_logs`（`actor_role=system`）；失败在超级管理后台显著告警（AC-23） | PRD §12.3、§11.3 |
| 业务数据 | 无产品级硬删除，长期积累风险以归档/状态管理应对，治理政策后续制定 | PRD §16.1、§16.2 |
| 导出文件 | 不自动失效；受保护目录 + 鉴权下载 + 不可猜 URL | FR-EXP-005、§10.3 |
| 参与者会话 | token 默认 30 天，主动退出立即失效 | FR-AUTH-006、§12.4 |

备份任务实现与恢复演练属部署侧内容，详见 technical-design.md；本文只约束数据侧口径。

## 6. T0 冻结的目标契约（计划中 schema）

本节是 T1/T2/T3/T6 的数据库门禁。T1 手机号字段与 challenge 集合已由 `1787895000_cc_participant_phone_auth.js` 实现；其余字段/集合仍不表示当前迁移已存在。机器名与前端共享类型以 `frontend/src/shared/api/accountEvent.ts` 为准。

### 6.1 participant_accounts 追加字段

| 字段 | 类型 | 迁移期必填 | 约束/语义 |
| --- | --- | --- | --- |
| `phone_e164` | text | 否 | 仅 `+86` + 11 位大陆手机号；普通 auth 响应隐藏，只在本人主动查看/换绑和有权敏感导出时按需暴露 |
| `phone_lookup_hash` | text | 否 | HMAC-SHA256(secret, `phone_e164`)；非空值唯一索引；服务端唯一写入且所有客户端响应隐藏 |
| `phone_verified_at` | date | 否 | 最近一次当前绑定号码验证成功时间 |
| `phone_binding_source` | select | 否 | `sms_signup | legacy_bind | manual_merge` |
| `phone_migration_status` | select | 是（回填） | `legacy_unbound | phone_bound | merge_required`；存量行先回填 `legacy_unbound` |

`passwordAuth.identityFields` 保持 `['username']`。新账号仍需满足 PocketBase auth 集合的 username/password 内部约束，但由服务端生成高熵不可猜值，不作为用户登录凭据展示。`phone_lookup_hash` 的 secret 只在部署环境注入；轮换密钥需专门双 hash/回填迁移，不得直接替换导致旧账号无法查找。

### 6.2 标准报名字段

| `field_code` | 类型 | 必填 | `is_sensitive` | 用途 |
| --- | --- | --- | --- | --- |
| `FULL_NAME` | text | 是 | true | 审核、现场联系、向本人搭档展示；不进入普通指标 |
| `GENDER` | single_choice | 否 | false | 仅阈值为 5 的聚合统计 |
| `AGE_RANGE` | single_choice | 否 | false | 仅阈值为 5 的聚合统计；不新增 `BIRTH_YEAR`/生日 |

三者均为 `source_type=standard`、`role_scope=both`。迁移首次注册时先置 `status=disabled`，待新报名 UI 和服务端校验同时上线再原子启用；禁止单独把 `FULL_NAME.required_default=true` 推到旧活动而阻断报名。选项机器值见共享契约文件。

### 6.3 activities / checkins 追加字段

`activities` 追加：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `pairing_started_at` / `pairing_started_by` | date / text | 首次“开始配对”的服务端事实；非空时迟到签到可触发队首补配 |
| `onsite_locked_at` / `onsite_locked_by` | date / text | “活动已开始”的系统判定；只能由幂等 lock 端点首次写入 |
| `next_speaker_sequence` / `next_listener_sequence` | number / number | required，默认 1；服务端编号事务专用计数器，不进入客户端快照或导出 |

`checkins` 追加：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `onsite_role` | select(speaker, listener) | 编号时的报名角色快照；编号后不随报名角色变更 |
| `onsite_sequence` | number | 活动+角色内从 1 递增；对 `>0` 的值建 `(activity_id, onsite_role, onsite_sequence)` 唯一索引 |
| `numbered_at` | date | 号码发出时间 |

在线分配号码与 valid 签到在同一事务中完成。服务端按报名角色原子读取并递增 `next_speaker_sequence` 或 `next_listener_sequence`，把递增前的值写入 `onsite_sequence`；编号顺序定义为数据库成功执行对应计数器自增的顺序，与写事务提交顺序一致。事务/唯一索引冲突时重试整个事务，不读取 `max(onsite_sequence)`，也不用 `checked_in_at` 或预生成 `checkin_id` 推断并发先后。撤销签到保留三个字段且不回退计数器，故序号不复用；存量签到不补号。

### 6.4 activity_pairs（新 base collection）

| 字段 | 类型 | 约束/语义 |
| --- | --- | --- |
| `activity_id` | relation(activities) | required；机构隔离从 activity 反查 |
| `pair_sequence` | number | required；`(activity_id, pair_sequence)` 唯一；释放后不复用 |
| `speaker_registration_id` / `listener_registration_id` | relation(registrations) | required；两条报名必须同活动且角色分别匹配 |
| `speaker_checkin_id` / `listener_checkin_id` | relation(checkins) | required；必须是对应报名的 valid 签到 |
| `status` | select(active, released, completed) | required；只能经配对 hooks 迁移 |
| `paired_at` / `paired_by` | date / text | required；自动补配的 actor 为触发操作者或 system |
| `adjustment_reason` | text | 手工调整新建的 pair 必填 |
| `released_at/by/reason` | date / text / text | 释放时写；锁定后 reason 必填 |
| `completed_at` | date | completed 时写 |
| `created` / `updated` | autodate | 显式声明 |

list/view rule：admin 仅本机构，super 全局，participant 全部关闭；create/update/delete 对 collection API 全关，只经 hooks。参与者只经 `my-pairing` 白名单快照与受控自定义 Realtime topic 获取最小信息，不得读取或订阅 pair record。单个 active pair 内双方不得相同；同一参与者同活动至多一个 active pair。后一约束横跨两个 relation 列，由事务内检查 + 相关复合索引保障，不声称单一 SQL unique 能完整表达。

### 6.5 export_jobs.scope_json v2

`scope_json` 存入 `StoredExportSelectionV2` 归一化快照：`schema_version=2`、`source_schema_version`、scope、datasets、survey_ids、filters、columns、format、timezone；v2 请求写 `source_schema_version=2`，旧请求写 `source_schema_version=1`。`include_pii` 暂保留作查询/兼容列，但由服务端根据字段定义和账号列策略派生，不信任客户端 `include_pii`。

建议新增对 JSON 中常用顶层口径的冗余列只在实测查询瓶颈后评审；T0 不为未证实性能问题增加第二份可漂移状态。

### 6.6 迁移、回填与回滚顺序

1. **M1 additive**：手机号/现场字段 required=false，新活动状态字段可空、两个角色计数器 required 且默认 1，创建 `activity_pairs`，将三个标准字段以 disabled 数据注册。
2. **M2 backfill**：在同一 migration 或可重入后台任务中把全部存量账号标记 `legacy_unbound`；不为历史签到伪造现场号，不为历史报名伪造姓名。
3. **M3 server dual compatibility**：先部署验证码/hashing、配对事务、快照、v1→v2 导出归一化；新字段仍未全局强制。
4. **M4 clients and activation**：再部署新前端和 Realtime；端到端验收后启用标准字段和手机号主入口。
5. **M5 cleanup**：观察至少一个发布窗口后另建 PR 评估旧 username 入口/v1 parser；保留历史字段与数据，无硬删除。

down 迁移只允许在新字段/集合尚无业务数据时回滚 schema。一旦已绑定手机号或已生成配对，生产回滚应是停用新入口/回切双读，不删数据列或集合。

## 7. 验收标准

本设计落地的验收映射（完整 AC 清单与测试分层见 test-plan.md）：

| 验收 | 与本文的关系 | 验证方式 |
|---|---|---|
| AC-02 一次性邀请码 | `admin_invites` 4 态 + 事务注册 | 重复使用/过期邀请码注册失败 |
| AC-03 机构隔离 | §5.4 规则与冗余 `organization_id` | 自动化越权测试全部通过 |
| AC-06 自动注册/登录 | `participant_accounts` 唯一用户名归一化 | 错误密码不产生重复账号；用户名规则生效 |
| AC-07 报名审核与回退 | §5.5 迁移矩阵 + `registrations` 约束 | 矩阵外迁移被拒；回退留痕 |
| AC-08 名额硬限制 | §5.6 事务校验 | 并发审核不超额；名额不可低于已通过数 |
| AC-09 固定二维码签到 | `checkin_qr_token` + `checkin_sessions` + `checkins` 唯一有效约束 | 仅通过者开放期可签到，一人一条 |
| AC-12 答卷锁定与作废 | `submissions` 3 态 | 提交后不可改；作废不计统计与导出 |
| AC-13 模板版本 | `survey_template_versions` 不可变 + 物化复制 | 模板更新不影响已有问卷与历史答卷 |
| AC-16 规范化导出 | `is_sensitive` 标记链路（字段/题目→答案→导出） | ZIP 含规定 CSV；普通导出按标记过滤 |
| AC-18 无硬删除 | deleteRule 全关 | 界面与 API 无永久删除入口 |
| AC-20 幂等提交 | 复合唯一索引 + 服务端查重 | 重试/重复点击无重复正式记录 |
| AC-23 备份告警 | `audit_logs` 系统事件 | 模拟失败后有审计记录与后台告警 |

## 8. 待确认

| 编号 | 事项 | 缺少什么证据 | 当前处理 |
|---|---|---|---|
| D-2 | 标准问卷完整题目与哪些题 `locked` | 模板内容未经确认（PRD §16.2） | 结构按版本 + `locked` 实现；题目内容不入库草案 |
| D-3 | 活动级报名字段「启用/必填」配置的存储位置 | PRD §9.1 未给出对应集合 | 草案暂放 `activities.form_config_json`；若配置复杂度上升，评审后可拆关联表 |
| D-4 | 全部枚举机器码（活动/报名/签到/问卷/答卷/邀请码状态值） | PRD 只定义中文状态名，无英文机器码约定 | 本文值为草案建议；首个迁移落地后冻结，只增不改 |
| D-5 | 已归档（archived）活动的公开详情页是否仍可访问 | PRD §4.3 仅述「只读为主、可导出、不进入默认活动列表」，未明确公开入口 | 草案 viewRule 暂不含 `archived`；确认后调整 |
| D-6 | `audit_logs.action` 动作代码全集与 `metadata` 结构约定 | PRD §11.3/FR-AUD-004 给出事件类别，未给代码表 | 由 security-privacy.md 细化；首版实现时随代码冻结 |
| D-7 | 二级业务表（`registrations` 等）是否冗余 `organization_id` 字段 | PRD §9.2 允许「带有或可可靠反查」两种实现，未指定 | 本文按「冗余」建议（规则简单、可索引）；实现评审可改纯反查 |
| D-8 | 参与者多账号的人工合并数据模型 | 已确认冲突时不自动覆盖，但尚无可审计的合并流程与关系转移方案 | 自动绑定停止并标记 `merge_required`；保持原 `participant_id`，人工模型另行评审 |
| D-9 | posts 封面图体积上限与图片规格 | 2026-08 后端改版计划只定「封面图可空、单图、image/*」，体积上限无依据 | 迁移暂定 maxSize=5MB；确认后调整迁移与本文 |
