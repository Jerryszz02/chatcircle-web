# Chat Circles — 项目规划文档索引

> 本文件是 `docs/planning/` 规划文档的索引。本目录是**设计与需求基线**文档（开发前编写，描述设计意图与 PRD 口径），按本文顺序阅读即可建立设计全貌，再按需深入各专题文档。
>
> 如果你要找的是**代码现状**与开发上手指引（本地开发、架构落地、如何修改），请读 [`docs/developer-guide.md`](../developer-guide.md)——那份文档随代码同步维护，与本目录的设计文档定位不同；两边不一致时以代码为准。

## 项目是什么

**Chat Circles** 是由 Empact 统一运营的**多机构活动管理、报名审核、签到与问卷数据平台**。当前默认分支已经包含 React + PocketBase 前后端、测试与部署配置；手机号账号、现场配对、单活动实时工作台和细粒度导出仍属于`计划中`功能。T0 只已冻结它们的共享契约与迁移边界，不能当作 T1–T6 已实现。

- 多机构集中管理：Empact 集中式平台，统一数据库，机构间按 `organization_id` 逻辑隔离。
- 活动全生命周期：活动创建/发布/传播（链接与二维码；另设公开活动广场页 `/activities`，仅展示已发布/已关闭活动）→ 报名与人工审核（角色名额硬限制、误判回退）→ 现场固定二维码签到（含补签/撤销）→ 多份问卷发布与填写 → 基础项目管理看板 → 规范化 ZIP/CSV 数据导出。
- 聆听者培训体系（2026-08 扩展，PRD 外）：机构级培训创建/发布/关闭、固定二维码培训签到（资格 = 账号存在 approved 聆听者报名，全平台通用）、账号级「培训通过」标记（仅记录与展示，不作报名门槛）。
- 三级账号权限：超级管理员、机构管理员、参与者。参与者当前实现为用户名+密码；目标状态为中国大陆手机号验证码登录/注册，存量账号通过验证码绑定手机号并保留原 `participant_id`。
- 现场执行升级（计划中）：按签到顺序为倾诉者/聆听者编号和配对，参与者端只展示本人的编号、组号与搭档姓名。
- 机构效率升级（计划中）：活动创建向导、单场活动实时工作台、参与者结构聚合和可按活动/问卷/参与者/字段选择的细粒度导出。

正式入口域名：`chatcircle.empact.cn`。

## 解决什么问题

现有流程分散在**第三方问卷、人工名单和线下沟通**中（PRD §1.1）：

- 报名、签到、问卷数据散落各处，难以形成稳定的机构级与平台级数据资产；
- 难以保证同一参与者在多场活动中的账号连续性；
- 申请人数、审核通过人数、实际参与人数三者无法准确区分（平台以「报名 ≠ 参加」为口径，实际参与以有效签到记录为准）。

Chat Circles 以统一活动链接/二维码承载全部参与者链路，用全平台通用参与者账号关联跨机构、跨活动的报名与问卷记录，并通过标准字段代码、模板版本与规范化导出，为后续统计分析、LLM 质性分析和报告生成提供可扩展的数据基础。

## 用户角色

平台只有三类角色（PRD §3）：

| 角色 | 使用者 | 数据范围 | 核心权限 |
|---|---|---|---|
| 超级管理员 | Empact 公司人员 | 全平台全部机构和数据 | 创建/配置机构、生成一次性管理员邀请码、活动审批/下架、配置机构级开关（发布审核、敏感导出）、全局看板/导出/审计、备份告警 |
| 机构管理员 | 合作机构工作人员 | 仅所属机构 | 活动管理、报名表与问卷配置、报名审核、签到控制与补签、本机构看板/审计/按权限导出 |
| 参与者 | 活动参与者 | 仅本人相关记录 | 查看公开活动详情、登录/自动注册、提交报名、查看审核状态、扫码签到、填写被授权问卷、查看本人已提交答案 |

**重要区分**：「倾诉者」与「聆听者」**不是平台权限角色**，而是每条报名记录上的活动内角色（`activity_role`）。同一参与者账号可在不同活动中选择不同角色；管理员审核时可修改该次报名的角色。旧 PRD 的匿名/假名化口径已被手机号账号计划调整，最新隐私边界见 [account-event-workflow-prd.md](account-event-workflow-prd.md) §8。

## 文档生成背景

| 项 | 内容 |
|---|---|
| 生成请求 | 归档 2026-08-27 专项升级，并于 2026-08-28 实施 T0 共享契约与迁移设计 |
| 初始生成 | 2026-08-05 |
| 最近同步 | 2026-08-28（T0 `已验证`）：新增 [api-design.md](api-design.md) 和共享类型，冻结手机号、报名标准字段、现场编号/配对、Realtime 失效化、导出 v2 与 v1 兼容顺序。 |
| 已检查的项目根目录 | `/Users/jerryszz/Desktop/实习/Empact/chatcircleWeb-t0-shared-contracts`；`agent/t0-shared-contracts` 从 `origin/main` `57a0aad` 创建。不把本工作分支写成已部署生产状态。 |
| 本次关键代码证据 | `participant_accounts` 仍以 `username` 为 identity；`checkins` 无现场号，无 `activity_pairs`；导出仍是固定 ZIP/CSV + `include_pii`。PocketBase 0.28.4 隔离探针证明 text 手机号 identity 技术可行，但 T0 因“短信验证码 only”选择服务端验证后签 token。 |
| 本次验证命令 | 2026-08-28 已通过 `npm test`（43 files / 310 tests）、`npm run typecheck`、`npm run lint`、`npm run build` 与 planning 索引/链接审计。 |
| 目标技术决策 | 保持 React 18 + Vite + TypeScript + PocketBase + SQLite；T1–T6 按 `2026-08-28.t0-v1` 新增阿里云短信认证、PocketBase Realtime/SSE、配对数据模型、活动工作台与 XLSX/CSV 细粒度导出。 |

## 已生成文档

| 文档 | 用途 |
|---|---|
| [technical-design.md](technical-design.md) | 技术架构与实现指引：技术栈、前后端结构、PocketBase 接入方式、关键实现决策、部署与备份要点、决策记录 |
| [api-design.md](api-design.md) | **T0 契约权威文档**：手机号认证、快照/配对、Realtime 失效化、导出 v2 的请求/响应、权限、幂等、错误与 v1 兼容契约 |
| [database-design.md](database-design.md) | 数据模型落地：PocketBase 集合设计、字段与关系、机构隔离规则、状态机与事务约束 |
| [security-privacy.md](security-privacy.md) | 安全、隐私与审计要求：认证与会话策略、权限边界、审计事件清单、敏感数据处理与隐私表述 |
| [test-plan.md](test-plan.md) | 测试与 CI 策略：测试分层、AC-01~26 验收映射（AC-24~26 为 2026-08 后端改版续编）、越权自动化测试与 CI 流水线 |
| [ui-design.md](ui-design.md) | 前端视觉与交互规范：色彩/字体/间距/动效 token、组件规则、响应式与无障碍基线、文案语气、图表样式；仅含纯前端 UI，业务口径以 PRD 与本目录其他文档为准 |
| [account-event-workflow-prd.md](account-event-workflow-prd.md) | **2026-08-27 专项升级主入口**：手机号账号、机构活动全流程、实时看板、现场编号与配对、参与者端展示、细粒度导出、隐私边界、API 草案、并行任务和验收清单 |

## 有意跳过的目录文档

以下按规划目录模板本应存在的文档，经判断**有意跳过或合并**，避免双源漂移与过度文档化：

| 跳过的文档 | 处理方式 | 原因 |
|---|---|---|
| project-brief.md | 并入本 README | 项目背景、目标与用户角色已在上文覆盖，单独成篇会重复 |
| prd.md | 不生成通用副本 | 原 V1 需求基线仍以 `docs/` 下 PRD v0.3 docx 为准；2026-08-27 新增范围单独维护在 [account-event-workflow-prd.md](account-event-workflow-prd.md)，避免改写历史 PRD |
| architecture.md | 并入 [technical-design.md](technical-design.md) | 架构内容与技术实现指引一体，拆分只会制造交叉引用负担 |
| user-flow.md | 不生成 | 核心业务流程见 PRD §5；状态机与迁移约束见 [database-design.md](database-design.md) |
| release-plan.md | 拆分合并 | 部署与备份要点并入 [technical-design.md](technical-design.md)；上线 checklist 属 M5 阶段产物 |
| operations-runbook.md | 暂缓 | 运维手册属 M5「生产交付」阶段产物，现阶段标记为待确认 |
| decision-log.md | 并入 [technical-design.md](technical-design.md) | 关键决策以表格形式记录在技术设计文档中，避免维护两份决策清单 |

## 核心概念速览

| 概念 | 一句话说明 | 依据 |
|---|---|---|
| 数据层级 | 平台（Empact）→ 机构（Organization）→ 活动（Activity）；V1 不设「项目」层级，`activities.group_tag` 为预留分组字段（可空） | PRD §4.1 |
| 单次场次口径 | 一个活动对应一个活动时间和一个签到周期；系列/多场次活动须拆分为多个活动 | PRD §4.1 |
| 报名 ≠ 参加 | 申请、审核通过、签到是三个独立状态；实际参与人数以有效签到记录为准 | PRD §2.3、§7.1 |
| 分角色报名问卷 | 报名字段带 `role_scope`（both/speaker/listener）；报名校验与表单展示按所选角色过滤适用字段，对不适用字段提交答案报 `field_not_applicable` | 2026-08 扩展（PRD 外），database-design §5.2.7 |
| 聆听者培训 | 培训与活动解绑、机构级创建；签到资格 = 账号存在 approved 聆听者报名（全平台通用）；任一 valid 出席即账号级「培训通过」标记 | 2026-08 扩展（PRD 外），database-design §5.2.20~5.2.22 |
| 内容推文 posts | 独立内容模块（与 activities 无关）：标题/摘要/封面图/Markdown 正文/外链，带置顶与显隐开关；仅超管可编辑（机构管理员无入口），公开端仅见 visible；首页成效数据走公开端点 `GET /api/cc/public/outcome` 自动聚合，不挂手填数据 | 2026-08 后端改版（PRD 外），database-design §5.2.24 |
| 无硬删除 | 业务记录只能归档、禁用、作废或变更状态，产品界面不提供任何永久删除 | PRD §2.3、FR-AUD-001 |
| 敏感标记驱动导出过滤 | 报名字段与问卷题目带 `is_sensitive` 标记；普通导出按标记排除/掩码，不依赖字段名判断 | PRD §10.2、FR-EXP-002 |
| 机构逻辑隔离 | 所有机构业务数据带 `organization_id`，服务端强制注入权限条件，不能只依赖前端隐藏 | PRD §9.2、§12.2 |
| 一次性邀请码 | 机构管理员凭超级管理员生成的一次性邀请码自行注册（默认 7 天有效），用后立即失效 | PRD §5.1 |
| 唯一超级管理员 | 全平台仅一个超级管理员账号，初始部署时创建；V1 无创建/停用/更换的产品界面 | PRD §3、FR-AUTH-009 |
| 参与者账号演进 | 当前为用户名+密码且无找回；目标为手机号验证码登录，存量用户先登录原账号再绑定手机号，保留原 `participant_id` | [account-event-workflow-prd.md](account-event-workflow-prd.md) §3 |
| 现场编号与配对 | 计划按 `checked_in_at ASC, checkin_id ASC` 分角色编号；管理员开始配对后按两侧队列顺序配对，不自动重排已有组 | [account-event-workflow-prd.md](account-event-workflow-prd.md) §5 |
| 双问卷完成率 | 现场与总体完成率的分子都必须与各自当前分母人群取交集；撤销签到或回退报名后同步移出对应分子，比例不得超过 100% | [account-event-workflow-prd.md](account-event-workflow-prd.md) §4.3 |
| 细粒度导出 | 计划支持单活动、单问卷、指定参与者、行筛选、字段/题目选择；任一所选报名字段或问卷题目 `is_sensitive=true`，或选择账号层敏感字段时，均由服务端触发敏感导出门槛 | [account-event-workflow-prd.md](account-event-workflow-prd.md) §7 |

## 开发入口

仓库已经完成初始化。当前代码结构、本地启动、测试与部署命令以 [开发者指南](../developer-guide.md) 和各 package 的 `package.json` 为准；planning 文档不复制易漂移的命令。T0 合并后，Wave 1 必须先读 [api-design.md](api-design.md) 并复用 `frontend/src/shared/api/accountEvent.ts`；不得在 T1/T2/T3 内改名或另造契约。

## Roadmap

下表为原 V1 的`历史记录`（引用 PRD §15，范围 M0~M5），不代表 2026-08-27 专项升级的当前任务状态。新任务拆分以 [account-event-workflow-prd.md](account-event-workflow-prd.md) §10 为准。

| 阶段 | 核心交付 | 退出条件 |
|---|---|---|
| M0 技术骨架 | Docker、PocketBase、统一域名环境、迁移、三级账号（含唯一超级管理员）和机构隔离原型 | 本地与测试服务器可一键启动；隔离测试通过 |
| M1 机构与活动 | 机构、一次性邀请码、活动、发布审核、链接/二维码、名额 | 可完整创建机构和发布活动 |
| M2 报名与签到 | 自动注册/登录、通用登录页与「我的」中心、报名表、审核与状态回退、角色、事务内硬名额校验、固定二维码签到和补签 | 从活动详情到实际签到完整跑通 |
| M3 问卷 | 标准模板、有限编辑、多问卷、角色访问、草稿、提交、作废 | 倾诉者和聆听者问卷可独立发布和提交 |
| M4 看板与导出 | 基础看板、指标聚合、规范化 ZIP/CSV、普通/敏感导出（按敏感标记过滤）和审计 | 指标口径与导出数据一致 |
| M5 生产交付 | 备份恢复与失败告警、操作手册、试点、缺陷修复和版本冻结 | 至少一场真实活动全链路验收通过 |

## License

**待确认**：本项目为内部项目，归 Empact 所有；是否添加正式 License 文件及其条款尚未确定，缺少 Empact 方面的授权证据。

## 贡献方式

内部团队项目。约定：

- 所有变更通过 Pull Request 提交，需通过 CI 全部检查（见 [test-plan.md](test-plan.md)）；
- CI 中必须包含机构**越权访问自动化测试**（AC-03），越权用例失败即阻塞合并；
- 需求口径以 PRD v0.3 为基线，未经评审不得自行改变业务口径（PRD §0）。

## 待确认项汇总

以下信息 PRD 未明确或缺少证据，文档中一律标记为「待确认」，不得编造：

| 事项 | 缺少什么 | 出处/去向 |
|---|---|---|
| 标准问卷完整题目与锁定题范围 | 模板内容确认 | PRD §16.2；结构按版本 + `locked` 字段实现 |
| 存量手机号冲突与多账号合并 | 同一手机号已被另一账号绑定时的受审计人工流程 | [account-event-workflow-prd.md](account-event-workflow-prd.md) §3.2、§12 |
| 长期维护、保修、升级与责任划分 | 运维与商务约定 | PRD §16.2；不阻塞 V1 |
| 机构独立域名方案 | host → organization 映射的实施计划 | PRD §12.2、§16.2；V1 统一使用 `chatcircle.empact.cn` |
| 数据治理与法定删除请求处理 | 管理政策 | PRD §16.2；V1 不提供硬删除 |
| operations-runbook.md（运维手册） | M5 阶段产物，现阶段无内容来源 | 本索引「有意跳过」表 |
| License | Empact 对许可条款的决定 | 见上文 License 节 |
| 阿里云短信认证生产配置 | 实际账号开通、AccessKey 安全下发、费用和测试号码 | [account-event-workflow-prd.md](account-event-workflow-prd.md) §12 |
| UI 设计稿与规划文档的业务冲突项 | 设计稿中的 Skill 入口、活动列表/推荐、通知中心等不作为实现依据；如需采纳须先回 PRD 评审 | 见 [ui-design.md](ui-design.md)「非目标」 |
| SMTP 凭据下发与验证/找回邮件模板配置（2026-08 改版） | PB Settings 手工配置的责任人、凭据下发方式、模板文案与前端落地路由对应关系 | 见 [technical-design.md](technical-design.md)「待确认」#18/#19、security-privacy.md §14 |
