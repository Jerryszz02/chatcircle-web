# 账号、现场与导出 API 契约

本文说明维护时必须保持的权限与业务语义。类型、枚举和端点构造器以 `frontend/src/shared/api/accountEvent.ts` 为代码源；具体行为以 `backend/pb_hooks/` 及对应集成测试为准。业务目的见 [业务规则](business-rules.md)，数据库概览见 [开发指南](developer-guide.md)。

## 1. 权威边界

- 前端 feature 不另写一份同义请求/响应类型。hooks 无法直接 import TypeScript，机器值变更须同步服务端、共享类型及测试。
- 当前契约版本为 `2026-08-28.t0-v1`，不因为文档整理而改变 HTTP 契约。
- 新增端点、枚举或隐私语义时，同 PR 更新本文、migration/hook 和越权测试。

## 2. 通用约定

- 管理员的机构范围由服务端身份与资源关系决定；跨机构资源与不存在资源统一返回 `404 not_found`。参与者只读自己的现场状态，不能枚举其他参与者或配对记录。
- 时间使用 ISO 8601 UTC；导出记录 IANA timezone，默认 `Asia/Shanghai`。
- 业务错误形状为 `{code: <HTTP status>, message, data: {code: <business_code>}}`；不把手机号、姓名、答案或验证码写入错误信息。
- 幂等和并发由各端点的唯一约束、事务内重读与状态机保证。不要假定发送 `Idempotency-Key` 就获得全局请求去重。

## 3. 参与者认证

主入口是用户名/手机号与密码；注册需要用户名、密码和已验证手机号。手机验证码可登录已有账号，首次验证不自动建号。数字用户名与手机号冲突时通过密码端点的 `identity_type`（auto/username/phone）消歧，显式类型不回退尝试另一种账号。

`phone_e164` 是 hidden 字段；查找和防重使用服务端计算的 `HMAC-SHA256(CC_PHONE_HASH_KEY, phone_e164)`，不接受客户端自报 hash。密钥须稳定保存，恢复数据库时一并恢复匹配配置。手机认证响应仅给掩码和绑定状态，不返回完整手机号、HMAC 或密码。

| `POST /api/cc/auth/participant` 下的路径 | 权限 | 当前行为 |
| --- | --- | --- |
| 无后缀 | 匿名 | 用户名/手机号 + 密码登录，不存在或错密码同形拒绝，不建号 |
| `/request-code` | 登录/注册/重置匿名；绑定/换绑须本人 | 号码、IP、设备会话限流；发码响应不区分账号是否存在 |
| `/verify-code` | 匿名 | 消费验证码并登录已有账号；未注册返回 `phone_not_registered`，停用账号不签发 token |
| `/register` | 匿名 | 用户名、密码、手机号验证码与隐私告知版本；建号、消费 challenge、审计同事务 |
| `/reset-password` | 匿名 | 手机验证码验证后重置密码，返回会话；未注册号码不能借此建号 |
| `/bind-phone` | participant | 绑定本人账号，保留 participant_id；冲突拒绝，不自动覆盖或合并 |
| `/change-phone` | participant | 旧号和新号双验证码原子换绑；无法验证旧号返回 `support_required`，没有人工单号绕过接口 |

错误码以 `phoneauth.pb.js` 为准，包含 `invalid_phone`、`privacy_notice_required`、`code_throttled`、`code_invalid`、`code_expired`、`challenge_consumed`、`account_disabled`、`phone_conflict`、`support_required`、`provider_unavailable`。发码响应收敛不表示验证后所有错误都同形。

管理员通过邀请码注册（用户名、邮箱、密码），邮箱验证/OTP/找回依赖受控 SMTP 配置；见[隐私运营手册](privacy-operations.md)。

## 4. 现场快照、编号与配对

### 4.1 端点

| Method / path | Auth | 契约 |
| --- | --- | --- |
| `GET /api/cc/activities/{activityId}/live-summary` | admin(本机构) / super | 返回 `ActivityLiveSummaryResponse`；所有指标在同一请求快照口径内计算 |
| `POST /api/cc/activities/{activityId}/pairings/start` | admin(本机构) / super | 首次写 `pairing_started_at/by` 并批量配对；重复请求只补齐等待队列，不重排旧组 |
| `POST /api/cc/activities/{activityId}/pairings/reassign` | admin(本机构) / super | `{speaker_checkin_id, listener_checkin_id, reason}`；原子释放涉及的 active pair 并新建一组，reason 必填 |
| `GET /api/cc/activities/{activityId}/my-pairing` | participant | 只返本人 `MyPairingResponse`；搭档姓名只来自该场报名 `FULL_NAME` |
| `POST /api/cc/activities/{activityId}/onsite/lock` | admin(本机构) / super | 幂等写 `onsite_locked_at/by`；锁定后撤销签到/调整只能经管理员并要求原因 |
| `POST /api/cc/activities/{activityId}/duplicate` | admin(本机构) | T4 复制活动：复制配置与问卷/题目物化行为新草稿，重新生成活动代码、签到 token 与问卷入口 token，不复制历史报名、签到、配对、答卷与审计记录；写 `activity.duplicate` 审计 |

`onsite_code` 由服务端按 `onsite_role + onsite_sequence` 派生：`speaker → S01`，`listener → L01`；`pair_code` 由 `pair_sequence` 派生为 `P01`。代码只用于展示，数据库唯一约束使用数值字段。

### 4.1.1 向导与模板约束

- activities create/update 接受 `planned_checkin_at`、`pairing_enabled`；计划时间仅提示。`is_template=true` 只允许 draft/archived，不可直接发布。
- duplicate 请求可带 `{as_template:true}` 另存机构模板，缺省复制为普通活动；复制重置预计签到/问卷时间和现场历史，保留配对开关与问卷 phase。
- `POST /api/cc/activities/{id}/surveys` 增加可选 `phase`（before/onsite/after，缺省 onsite）与 `planned_open_at`（日期），响应 survey 同步返回这两个字段；非法值 400。
- 标准 FULL_NAME 由服务端强制启用、必填、敏感、both；缺姓名/空白姓名返回 `400 REQUIRED_FIELD_MISSING`，标准定义缺失时 fail closed。活动配置不能覆盖此约束。
- `pairing_enabled=false` 时 start/reassign 返回 `400 pairing_disabled`；本人快照增加可选兼容字段 `pairing_enabled`，前端显示未启用，不显示等待开始配对。
- 新老参与者/历史次数为管理员端辅助聚合，查询本机构 `valid` checkins，按不同活动去重；截止本场开始与快照时间较早值，排除本场。不是 live-summary 原子主快照的一部分。

### 4.2 快照口径

- 现场问卷完成率的分子和分母都只取“当前 valid 签到 + 角色符合”的人群交集。
- 总体完成率的分子和分母都只取“当前 approved + 角色符合”的人群交集。
- 分母为 0 返回 `rate: null`；有值时强制在 `[0,1]`。
- `gender/age_range` 任一分组人数小于 5 时，该维度全部桶都返回 `{count:null, suppressed:true}`；只有该维度所有桶均达到 5 才展示计数，禁止结合 `registrations.approved.total` 或其他桶做减法反推。
- `recent_checkins.display_name` 只对有权管理员返回，不进入普通聚合图表。

## 5. Realtime 契约

T3 当前实现位于 `backend/pb_hooks/live.pb.js` 与 `frontend/src/features/admin/lib/activityLive.ts`。管理端严格先建立六类快照依赖订阅再拉快照，record event 仅防抖触发重拉；SDK 每次重新收到 `PB_CONNECT` 都强制刷新，连接状态轮询只用于离线提示。参与者 topic 的订阅与发送均按 auth id 二次过滤，非法 topic 被拒。T5 参与者侧实现位于 `frontend/src/features/participant/lib/myPairingLive.ts` 与 `lib/useMyPairing.ts`：同一“先订阅再拉快照”模式，订阅本人 `checkins`（按 participant_id 过滤）与 `cc.participant.pairing.{participantId}` topic，事件防抖后重拉 `my-pairing`；配对 topic 消息中与跟踪活动无关的 `activity_id` 直接忽略；一次调用可跟踪多个活动（「我的」中心单订阅多活动）；订阅失败时降级为一次性快照 + 离线提示。

Realtime 不传输第二套指标或配对真相，只用 PocketBase record event 或受控的自定义消息使 HTTP 快照失效：

| 消费者 | 订阅源 | 收到事件后 |
| --- | --- | --- |
| 活动工作台 | `activities`、`registrations`、`checkins`、`activity_surveys`、`submissions`、`activity_pairs`，按 activity 过滤 | 活动现场字段、问卷清单或业务记录变化后，均防抖重拉 `live-summary` |
| 参与者配对卡 | 本人 `checkins`、`cc.participant.pairing.{participantId}` 自定义 topic | 重拉 `my-pairing`；禁止订阅 `activity_pairs` |

客户端顺序必须是“先订阅，再拉快照”，避免初始快照与订阅之间的丢事件窗口。SSE 断开时显示离线状态；恢复时无条件重拉快照。collection list/view rule 仍是最终授权层，客户端 filter 不是权限边界。

配对事务提交成功后，服务端通过 PocketBase 官方支持的 [custom realtime message](https://pocketbase.io/docs/js-realtime/) 向双方 topic 各发送一次 `{contract_version, activity_id, changed_at}`，不得包含 pair record、双方 registration/checkin id、姓名、操作者或调整原因。`onRealtimeSubscribeRequest` 必须拒绝 topic 中 participantId 与当前 auth id 不一致的订阅；发送端还要按连接的 auth record 二次过滤，覆盖多标签页/多设备连接。

## 6. 细粒度导出 v2

### 6.1 请求

`POST /api/cc/exports/preview` 和 `POST /api/cc/exports` 共用 `ExportSelectionV2`：

- `scope`：`platform | organization | activity` + optional date range；指定参与者是 `filters.participant_ids`，不是列选择。
- `datasets`：`registrations | checkins | pairings | surveys`；`survey_ids` 空表示范围内全部问卷。
- `filters`：角色、报名状态、签到、配对、问卷完成与指定参与者。
- `columns.system`：固定系统列；`registration_field_codes` 和 `survey_questions` 以稳定机器码选列。
- `format`：`xlsx` 默认，`csv_zip` 供高级分析；`timezone` 进入 manifest/筛选摘要。

preview 返回归一化 selection、分数据域预估行数、`requires_sensitive_export`、触发的字段/题目代码与权限结果，不返回任何实际数据值。正式创建必须用同一服务端函数重新归一化和判敏，不信任 preview 旧结果或前端布尔值。

### 6.2 敏感门槛

任一下列选择使 `requires_sensitive_export=true`：

- 账号系统列 `phone_full`；配对表中的 `partner_name`；
- 任一 `registration_field_defs.is_sensitive=true` 字段（包括 `FULL_NAME`和机构自定义联系方式）；
- 任一 `survey_questions.is_sensitive=true` 题目。

`phone_masked` 不触发敏感门槛。机构管理员的敏感导出还必须开启 `allow_sensitive_export`；所有角色都必须传 `confirm_sensitive:true` 并写审计。审计 metadata 记录范围、筛选和机器码，不记完整手机号、姓名或答案。

### 6.3 v1 兼容

当请求无 `schema_version:2` 且形状为 `{scope, include_pii, confirm}` 时，按旧 v1 处理：

1. 服务端将其归一化为“范围内全数据域 + 全旧列 + `csv_zip`”的 v2 selection。
2. `include_pii=false` 依旧排除敏感字段；`include_pii=true` 依旧要求 `confirm:true` 和机构开关。
3. `export_jobs.scope_json` 写归一化后的 `StoredExportSelectionV2`；v2 请求带 `source_schema_version:2`，旧请求带 `source_schema_version:1`。`include_pii` 保留作兼容索引，值由服务端判敏结果派生。
4. 旧响应字段和 ZIP/CSV 文件清单保持不变。在所有已知客户端切换 v2 且完成一个发布窗口前，不删除 v1 parser。

## 7. 迁移、兼容与发布

追加迁移，保留历史账号 ID、报名/问卷数据与同意版本，不伪造缺失姓名或旧签到编号。新增 schema 先保证服务端兼容，再更新 UI；不能仅下线前端按钮而放任集合 API 绕过业务规则。

标准 `FULL_NAME` 已由服务端强制启用、必填和敏感；用户名密码是现行登录方式。MCP 仍使用 v1 CSV 导出，未迁移所有消费者前保留 v1 parser。迁移 down 不等于完整生产回滚，发布前按[发布清单](release-checklist.md)核对。

人工账号合并与丢失旧手机号恢复尚无完整后台流程；其他待维护事项集中在 [maintenance.md](maintenance.md)。
