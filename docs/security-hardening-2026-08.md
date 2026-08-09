# 安全加固批次记录（2026-08，分支 fix/security-hardening-20260807）

- 范围：Chat Circles 全栈安全评审后的集中修复（后端 hooks/迁移、前端、部署运维、测试与文档）。
- 基线：PocketBase 0.28.4；PRD v0.3；technical-design / security-privacy（docs/planning/）。
- 本文档是落地记录与运维交接：修了什么、怎么验证、哪些行为变了、还剩什么。

---

## 1. 修复清单（按批次）

### 批次 A：集合直连写收口（纵深：API rules + 请求守卫）

- 新增 `backend/pb_hooks/guards.pb.js`：非超管直连 create/update `registrations`、`registration_answers`、`checkin_sessions` 一律 403，业务写只能走 `/api/cc/*` 端点（资格校验/状态机/事务为唯一服务端强制点）。
- `activities` 直连创建强制 `status='draft'`；直连更新禁改 `status` / `organization_id` / `checkin_qr_token`（同 `guards.pb.js`）。
- `registration_field_defs` 直连更新禁改 `organization_id` / `field_code`（同 `guards.pb.js`）。
- `participant_accounts` / `admin_accounts` 直连更新禁改 `status`（admin 另禁 `organization_id`），守卫为第二层（同 `guards.pb.js`）。
- 迁移 `backend/pb_migrations/1785889080_cc_rule_hardening.js`：两个账号集合 `updateRule` 追加 `@request.body.status:isset = false`（rule 先于守卫触发，status 自改实测 404）。
- 超管全部放行（运维/测试通道），规则对 `_superusers` 天然豁免。

### 批次 B：认证限流与枚举收敛

- 新增 `backend/pb_hooks/authguard.pb.js`：PB 内置 `*/auth-with-password` 补限流——per-IP 20 次/10 分钟（全集合共享桶，含成功尝试）+ per-身份+IP 失败 5 次/10 分钟，超限 429 `TOO_MANY_ATTEMPTS`；成功清除该身份失败计数。
- `backend/pb_hooks/auth.pb.js`：参与者端点补 per-IP 喷洒限流 30 次失败/10 分钟；注册 per-IP 10 账号/小时（429 `REGISTRATION_RATE_LIMITED`，本机直连 loopback 且无 XFF 头豁免，集成测试不受影响）。
- 枚举收敛：参与者端点密码格式（8–71 位）校验前置到账号 lookup 之前，消除「不存在账号先撞格式错误」的账号枚举 oracle（`auth.pb.js`）。

### 批次 C：后端逻辑修复与签到二维码后端

- 签到 self 端点改为 `POST /api/cc/checkin/self { token }`（token = `checkin_qr_token`，查无 404 `ACTIVITY_NOT_FOUND`）；旧路由 `POST /api/cc/checkin/{activityId}/self` 删除（404）（`backend/pb_hooks/checkins.pb.js`）。
- `checkin_qr_token` 改服务端唯一生成：创建活动时模型钩子生成 24 位强随机 token（`activities.pb.js` onRecordCreate）；迁移 `1785889140_cc_hardening_schema.js` 将字段改 `required=false` 并保留唯一索引。
- `activities.viewRule` 收紧为仅本机构管理员（迁移 `1785889140`）：匿名/参与者原生 view 一律 404，公开详情只走 `/api/cc/public/activities*`（字段白名单下发，不含 `checkin_qr_token`）。
- `POST /api/cc/super/backup/run` 下线为 410 `backup_deprecated`（原 JSVM 库文件复制非一致性快照，假备份治理），不再写 `backup.*` 审计；`backup-status` 端点保留（`backend/pb_hooks/super.pb.js`）。
- 导出限流与审计：`POST /api/cc/exports` per 机构 10 次/小时、per 超管 20 次/小时（429）；下载写 `export.download` 审计；CSV 单元格以 `= + - @` 或 Tab 开头前置 `'`（公式注入中和）（`backend/pb_hooks/exports.pb.js`）。
- 答案校验：问卷 draft/submit 按 `question_type` 校验（选项成员、scale 范围、文本 ≤2000）（`backend/pb_hooks/submissions.pb.js`）；报名答案 text ≤2000、number 须有限、date 锚定 YYYY-MM-DD、选项成员校验（`backend/pb_hooks/registrations.pb.js`）。
- 事务/并发：报名 transition 与签到 self 校验移入事务内（消除 TOCTOU），SQLite busy 重试 ≤2 次后 409 `CONFLICT`；approve/reject 对 taken_down/archived 活动 400 `ACTIVITY_UNAVAILABLE`（`registrations.pb.js`）；checkin open 对 draft/taken_down/archived 活动 400 `ACTIVITY_NOT_OPEN`（`checkins.pb.js`）。
- 指标口径修正：`survey_completion_rate` 分子只计报名当前仍为已通过的提交；metrics from/to 仅接受 YYYY-MM-DD（`backend/pb_hooks/metrics.pb.js`）。
- 统一错误形态收敛：全部自定义端点改 `{ code, message, data: { code } }`，内部错误细节不再回传客户端（各 hooks 文件）。

### 批次 D：前端修复与签到二维码前端

- 签到落地页改 `/checkin/:token`（`frontend/src/router.tsx`、`features/participant/pages/CheckinPage.tsx`），提交 `POST /api/cc/checkin/self { token }`（`features/participant/api.ts`）。
- 管理端签到面板二维码内容改为 `/checkin/{checkin_qr_token}` 落地链接（`features/admin/pages/detail/CheckinPanel.tsx`、`components/QrDisplay.tsx`）。
- 管理端（admin/super）401 统一处理：会话失效清本地会话并跳对应登录页（`shared/pocketbase.ts`、`shared/guards.tsx`、`shared/session.ts`）。
- `PB_URL` 空值/未设置统一回退 `window.location.origin`（同源伺服与 vite dev 代理两种形态都正确）（`shared/pocketbase.ts`）。
- 退出登录语义修正为「仅清本地会话，服务端 token 自然过期」（`shared/auth.ts`）。
- 导出/审计/看板等页面配合新错误码与口径的展示修正（`features/superadmin/*`、`features/admin/*`）。

### 批次 F：部署运维加固

- Caddy 安全响应头（HSTS / nosniff / Referrer-Policy / CSP / X-Frame-Options）（`deploy/Caddyfile`）。
- 生产封闭 PocketBase 管理台 `/_/ *`（403，排障可临时放开）（`deploy/Caddyfile`）。
- 反代覆盖（而非追加）客户端伪造的 `X-Forwarded-For`，保证限流/审计拿到真实来源（`deploy/Caddyfile`）。
- 镜像构建对 PocketBase 发行包做官方 sha256 校验（供应链，`Dockerfile`）。
- 容器日志体积限制（json-file 10m×3）；备份 crond 固定 `Asia/Shanghai` 时区（装 tzdata）（`docker-compose.yml`）。
- `.env.example` / `deploy/README.md`：阿里云 RAM 权限收窄指引（按 hosted zone 限定，仅 4 个 DNS Action，不再要 AliyunDNSFullAccess）。
- 每日一致性快照备份脚本（PB 备份 API + 原子结果标记 + 30 天滚动清理）（`deploy/backup.sh`）。

### 批次 G（本批次）：测试适配与回归

- 集成测试全面适配新契约并新增 `suite_hardening.py` 回归套件（27 断言），详见 `backend/tests/README.md`。
- E2E 主链路签到步骤改用 `checkin_qr_token` 落地链接（`e2e/scripts/seed.mjs`、`e2e/tests/main-flow.spec.ts`）。

---

## 2. 验证方式

| 层 | 命令 | 结果 |
| --- | --- | --- |
| L3 后端集成（12 套件） | `bash backend/tests/run_integration.sh` | 319 断言全绿（PASS=319 FAIL=0） |
| M0 迁移冒烟 | `bash backend/tests/migration_smoke.sh` | PASS=43 FAIL=0 |
| L4 E2E 主链路 | `cd e2e && npx playwright test` | 1 passed |
| L1/L2 前端单测 | `cd frontend && npm run test` | 全绿 |
| 前端类型检查 | `cd frontend && npm run typecheck` | 通过 |
| 前端 lint | `cd frontend && npm run lint` | 通过 |

集成测试全程在临时 `--dir` 自举实例（默认端口 8097），不触碰本地开发库 `backend/pb_data`。

---

## 3. 行为变更警示（上线/运维必读）

- **旧签到二维码全部作废，需重印**：签到落地链接由 `/checkin/{activityId}` 改为 `/checkin/{checkin_qr_token}`；token 为服务端生成的 24 位随机串（活动记录 `checkin_qr_token` 字段，管理端签到面板可取）。已印发/投屏的旧二维码扫码后 404，**上线前必须重新导出并替换全部活动的签到二维码**。
- **`POST /api/cc/super/backup/run` 已下线（410）**：手动演练入口不复存在；每日一致性快照由 `deploy/backup.sh` 自动执行。`backup-status` 读取 `backup.*` 审计聚合，**当前每日备份结果尚未回写审计**（写 `backups/last_backup.json` 标记文件），超管后台备份告警会以「尚无备份记录」alert=true 常态提示，接入前运维巡检以标记文件为准。
- **公开活动原生 view 关闭**：匿名/参与者 `GET /api/collections/activities/records/{id}` 一律 404（含 published/closed）；公开详情/列表只走 `/api/cc/public/activities*`（白名单字段）。任何依赖原生 view 拿公开活动的集成方必须改走公开端点。
- 内置认证端点全局限流：同一来源 IP 10 分钟内 `auth-with-password` 尝试超过 20 次即 429（含成功尝试）。**生产经 Caddy 反代时必须完成 §4 的 trusted proxy 配置**，否则全平台共享一个 IP 桶，正常用户会被互相误伤。
- 直连集合写（非超管）被守卫拦截：既有运维脚本/数据订正脚本若绕过 `/api/cc/*` 端点直连写业务集合，需改用超管凭据或改走端点。

---

## 4. 生产部署必做

1. **PB 控制台 Settings → 启用 trusted proxy headers（信任 `X-Forwarded-For`）**：否则 `e.realIP()` 只拿到 Caddy 容器地址，所有 per-IP 限流（内置认证 20 次/10 分钟、参与者喷洒/注册、导出）退化为全平台共享桶，等同全局限流。Caddy 侧已覆盖伪造 XFF（`deploy/Caddyfile`），两边必须同时生效。
2. 重印全部活动签到二维码（见 §3）。
3. 按 `.env.example` 最新指引收窄阿里云 RAM 策略（按 hosted zone + 4 个 DNS Action），轮换已在用的 AccessKey。
4. 确认备份告警巡检口径切换到 `backups/last_backup.json`（audit 回写接入前）。

---

## 5. Backlog（本次未做，按优先级）

- **PocketBase 0.28.4 → 0.39.x 升级**：单独分支做，含 hooks API 兼容回归（0.28→0.39 有破坏性变更），不夹带其他改动。
- **超管会话加固**：超管登录改 BFF/HttpOnly cookie（ token 不落 localStorage）+ MFA。
- **签到一次性 challenge**：固定 token 二维码可被转发代签；评估短时效一次性 challenge（权衡现场网络与扫码体验后立项）。
- 运维动作（不占代码分支）：**备份加密与异地同步**；**RAM 最小权限执行落地**（策略已给指引，需人工在阿里云控制台收窄并轮换密钥）；**删除服务器明文 override**（排查备份/恢复链路残留明文凭据或覆盖文件）。
- 待 PRD 确认：**草稿答卷是否纳入导出口径**；**超管敏感导出豁免口径**（当前超管不受机构 `allow_sensitive_export` 开关限制）。
- 工程化：导出异步化（当前同步生成，大数据量有超时风险）；容器非 root 运行；`getFullList` 全面分页（hooks 内查询改显式分页上限）。
