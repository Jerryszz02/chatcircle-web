# 手机号账号与活动现场 API 契约

> 状态：T0 与 T3 `已验证`；T1/T2/T4/T5/T6 仍为 `计划中`
>
> 契约版本：`2026-08-28.t0-v1`
>
> 适用范围：[account-event-workflow-prd.md](account-event-workflow-prd.md) 的手机号账号、现场编号/配对、实时工作台与细粒度导出
>
> 当前实现差距：本实现分支已提供 T3 `live-summary`、Realtime topic 守卫和管理端失效化订阅服务，但尚未证明已合并默认分支或部署；T1/T2/T6 的新 schema/端点仍未由本任务实现。实际代码现状以 [developer-guide.md](../developer-guide.md) 和 `backend/pb_hooks/` 为准。

## 1. 权威边界

- 机器名、枚举、请求/响应 TypeScript 类型与端点构造器的唯一代码源是 `frontend/src/shared/api/accountEvent.ts`。后续任务不得在 feature 目录内重新定义同义类型。
- 本文定义权限、幂等、敏感性与兼容语义；数据字段、索引与迁移顺序见 [database-design.md](database-design.md) 「6. T0 冻结契约」。
- PocketBase hooks 的 JSVM 不能直接 import 前端 TypeScript。服务端落地时必须按本契约复制机器值，并在同一 PR 用集成测试和 `accountEvent.test.ts` 防止漂移；不引入第二份手写前端类型。
- 本契约只冻结 T0 范围。新增业务端点、改枚举或改隐私语义时，必须同 PR 更新代码契约、本文、相关 migration/hook 与越权测试。

## 2. 通用约定

### 2.1 身份与范围

| 身份 | 允许范围 |
| --- | --- |
| 未登录 | 仅可请求/验证登录验证码；响应不泄露手机号是否已注册 |
| participant | 绑定/换绑本人手机号；只读本人签到与配对状态 |
| admin | 仅所属机构的活动快照、现场锁定、配对和导出 |
| super | 任意机构的活动快照、配对与导出；不因角色而放宽审计和二次确认 |

服务端从 auth record 与 activity relation 注入 `organization_id`，忽略客户端试图扩大范围的参数。管理员访问其他机构的活动、配对、快照、现场锁定或导出资源，与不存在的资源统一返回 `404 not_found`；参与者访问他人配对同样返回 `404 not_found`，禁止用 `403` 暴露资源存在性。

### 2.2 响应、时间与错误

- 新响应带 `contract_version: "2026-08-28.t0-v1"`；旧导出响应为保持兼容可不带。
- 时间均为 ISO 8601 UTC；导出另保存用户选择的 IANA timezone，默认 `Asia/Shanghai`。
- 错误延续现有形状：`{ code: <http status>, message, data: { code: <business_code> } }`。无业务字段的失败不把手机号、姓名、问卷答案或短信验证码写入 `message/data`。
- 所有改变状态的端点接受 `Idempotency-Key` header。服务端以唯一索引 + 事务内状态重读作最终保障，不仅依赖 header。

## 3. 手机号认证

### 3.1 T0 技术结论

2026-08-27 对 PocketBase 0.28.4 做了隔离临时库实测：给 auth collection 增加唯一 `phone_e164` text field 并写入 `passwordAuth.identityFields` 后，手机号+密码登录返回 200，重复手机号被唯一索引以 400 拒绝。

但目标产品是阿里云短信验证码，不是手机号+密码。因此 T0 决定：

1. `phone_e164` 是经验证的账号属性，不加入 `passwordAuth.identityFields`。
2. 精确查找和防重使用 `phone_lookup_hash = HMAC-SHA256(CC_PHONE_HASH_KEY, phone_e164)`，由服务端计算，客户端不上传。不使用可枚举的无密钥 SHA-256。T1 可直接使用 PocketBase JSVM 官方提供的 [`$security.hs256(message, secret)`](https://pocketbase.io/jsvm/interfaces/security.hs256.html)，密钥只从部署环境读取。
3. 阿里云验证成功后，hook 按 hash 查找/创建 record，检查 `status=active`，再调用 PocketBase record token 签发能力返回会话。
4. `username` 和当前 username+密码通道在存量迁移期保留；新手机号账号由服务端生成不向用户展示的高熵唯一 username 和随机密码。

手机号 auth 响应使用 `ParticipantPhoneAuthRecord`，不返回内部 `username/password`；手机号相关字段只返回 `phone_masked` 与绑定状态，不返回 `phone_e164` 或 `phone_lookup_hash`。完整号码只在本人主动查看/换绑和有权敏感导出流程中按需返回。

### 3.2 端点

| Method / path | Auth | 请求/响应 | 核心语义 |
| --- | --- | --- | --- |
| `POST /api/cc/auth/participant/request-code` | 匿名；bind/change 须 participant | `RequestPhoneCodeInput` → `RequestPhoneCodeResponse` | 同手机号/IP/设备会话限流；已注册与未注册响应同形 |
| `POST /api/cc/auth/participant/verify-code` | 匿名 | `VerifyPhoneCodeInput` → `ParticipantPhoneAuthResponse` | 验证码一次性消费；按 hash 幂等登录/建号；停用账号不签 token |
| `POST /api/cc/auth/participant/bind-phone` | participant | `BindPhoneInput` → `BindPhoneResponse` | 只绑当前 `participant_id`；号码已占用则停止并进入人工合并，不覆盖 |
| `POST /api/cc/auth/participant/change-phone` | participant | `ChangePhoneInput` → `BindPhoneResponse` | 新号验证成功后，经旧号验证码或人工支持单号证明后原子换绑；记录前后号码的掩码/hash，不记完整号码 |

统一业务错误码：`invalid_phone`、`code_throttled`、`code_invalid`、`code_expired`、`challenge_consumed`、`account_disabled`、`phone_conflict`、`provider_unavailable`。`request-code` 的限流/服务商失败不得变成账号存在性 oracle。

## 4. 现场快照、编号与配对

### 4.1 端点

| Method / path | Auth | 契约 |
| --- | --- | --- |
| `GET /api/cc/activities/{activityId}/live-summary` | admin(本机构) / super | 返回 `ActivityLiveSummaryResponse`；所有指标在同一请求快照口径内计算 |
| `POST /api/cc/activities/{activityId}/pairings/start` | admin(本机构) / super | 首次写 `pairing_started_at/by` 并批量配对；重复请求只补齐等待队列，不重排旧组 |
| `POST /api/cc/activities/{activityId}/pairings/reassign` | admin(本机构) / super | `{speaker_checkin_id, listener_checkin_id, reason}`；原子释放涉及的 active pair 并新建一组，reason 必填 |
| `GET /api/cc/activities/{activityId}/my-pairing` | participant | 只返本人 `MyPairingResponse`；搭档姓名只来自该场报名 `FULL_NAME` |
| `POST /api/cc/activities/{activityId}/onsite/lock` | admin(本机构) / super | 幂等写 `onsite_locked_at/by`；锁定后撤销签到/调整只能经管理员并要求原因 |

`onsite_code` 由服务端按 `onsite_role + onsite_sequence` 派生：`speaker → S01`，`listener → L01`；`pair_code` 由 `pair_sequence` 派生为 `P01`。代码只用于展示，数据库唯一约束使用数值字段。

### 4.2 快照口径

- 现场问卷完成率的分子和分母都只取“当前 valid 签到 + 角色符合”的人群交集。
- 总体完成率的分子和分母都只取“当前 approved + 角色符合”的人群交集。
- 分母为 0 返回 `rate: null`；有值时强制在 `[0,1]`。
- `gender/age_range` 任一分组人数小于 5 时，该维度全部桶都返回 `{count:null, suppressed:true}`；只有该维度所有桶均达到 5 才展示计数，禁止结合 `registrations.approved.total` 或其他桶做减法反推。
- `recent_checkins.display_name` 只对有权管理员返回，不进入普通聚合图表。

## 5. Realtime 契约

T3 当前实现位于 `backend/pb_hooks/live.pb.js` 与 `frontend/src/features/admin/lib/activityLive.ts`。管理端严格先建立六类快照依赖订阅再拉快照，record event 仅防抖触发重拉；SDK 每次重新收到 `PB_CONNECT` 都强制刷新，连接状态轮询只用于离线提示。参与者 topic 的订阅与发送均按 auth id 二次过滤，非法 topic 被拒。

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

## 7. 迁移与发布门禁

本 T0 不创建空集合、不启用新字段，避免默认分支出现无消费者的半实现。后续顺序必须是：

1. **Additive schema**：手机号字段可空、现场字段可空，新集合 rules 默认最小权限；标准字段先以 disabled 注册。
2. **Backfill**：存量账号标记 `legacy_unbound`；现有报名/签到/导出语义不变。
3. **Dual-read/write**：先上服务端归一化与旧请求兼容，再上新 UI/Realtime；所有新业务写入只走 hooks 事务。
4. **Activate**：T1/T2/T3 验收后再启用 `FULL_NAME`、手机号登录与现场配对；不要因标准字段的 global default 突然阻断旧活动报名。
5. **Cleanup**：观察一个发布窗口并确认无旧客户端后，才能单独 PR 评估下线 username 登录或 v1 导出 parser；不删历史字段/记录。

每一阶段必须通过迁移 up/down/up、身份/越权矩阵、幂等/并发、敏感导出、旧客户端兼容与 360px E2E 后才能进入下一步。

## 8. 非目标与待确认

- T0 不接入真实阿里云账号、不配置 secret、不创建 production migration，也不声称端点可用。
- `phone_conflict` 的人工合并后台产品流程仍 `待确认`；未确认前只停止自动绑定并审计，不作自动合并。
- 阿里云短信认证的实际请求/响应字段、价格、测试号码和错误码映射需 T1 在有权账号中联调确认；不改变本文的内部 API 形状。
