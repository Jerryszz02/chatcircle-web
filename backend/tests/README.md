# backend/tests/

服务端测试目录（L1/L2 在 frontend/）。

## 集成测试套件（L3，CI 必过）

一键入口：

```sh
bash backend/tests/run_integration.sh
```

运行方式（test-plan §3）：脚本在临时数据目录自举真实 PocketBase 实例——顺序应用全部
`pb_migrations` 迁移 → 创建测试超管 → SQL 直插模板 fixture → 显式
`--dir/--migrationsDir/--hooksDir` 启动 serve → `integration/run.py` 通过 HTTP 调用真实
API，**只断言 API 行为与数据终态，不测内部函数**。输出逐条 PASS/FAIL 与汇总，任一失败
退出码为 1。全程不污染本地 `pb_data/`；仅依赖 bash、curl、python3（标准库）。

环境变量：`CC_IT_PORT`（实例端口，默认 8097，避开本地开发 8090 与迁移冒烟 8099）、
`CC_IT_KEEP=1`（保留临时目录供调试）。

### 目录结构

| 文件 | 职责 |
| --- | --- |
| `run_integration.sh` | 一键入口：二进制准备（缺失自动下载 0.28.4）→ 自举实例 → 跑套件 → 清理 |
| `integration/run.py` | runner：`--sql-fixture` 模式直插模板；默认模式按序执行全部 suite 并汇总 |
| `integration/cc_client.py` | 薄 HTTP 客户端 + Reporter 断言收集器 |
| `integration/cc_fixture.py` | fixture 工厂（机构/管理员/活动/参与者/报名/问卷） |
| `integration/suite_*.py` | 各套件（见下表） |

### 套件与验收映射

| 套件 | 覆盖 | 断言数 |
| --- | --- | --- |
| `suite_flow.py` | 主链路全链路（自 /tmp/cc_e2e.py 联调沉淀）：邀请码→建活动→报名→审核→签到（token 二维码）→问卷→看板（含时间筛选重叠口径回归）→导出→备份端点下线形态→未认证形态；分角色报名问卷 role_scope（角色专属字段校验/field_not_applicable/下发）、me/overview 聆听者资格标记 | 58 |
| `suite_acl.py` | **越权矩阵 AC-03**（test-plan §4）：机构A管理员→机构B 活动/报名/答案/签到/配对/场次/问卷/题目/答卷/答案/导出/审计/机构/账号/培训/培训签到/培训场次的列表+详情，全部自定义端点，导出 scope 与看板参数伪造，横向：管理员→超管端点、参与者→管理端点与他人记录、未认证（含原生 view 收敛 404）、posts 推文越权写与 hidden 可见性（2026-08 改版） | 95 |
| `suite_capacity.py` | 名额事务硬校验与并发审核 AC-08：角色/总名额满拒过、新报名口径、偶数总名额与对半派生、名额修改下限、审核改角色撞满、双管理员并发审核不超额 | 17 |
| `suite_transitions.py` | 状态迁移矩阵 AC-07：5 种合法迁移 + 7 种非法组合枚举、原因必填、审计留痕（操作者/前后状态/原因）、回退重校验名额、同态幂等 | 19 |
| `suite_checkins.py` | 签到 AC-09/10/20：前置校验分支、重复扫码幂等、并发双扫一人一签、补签/撤销原因必填+审计、撤销保留记录、口径同步、补签候选人名单 | 25 |
| `suite_pairings.py` | T2 现场编号与配对：服务端初始化、并发签到/开始/调整、重复开始、跨页迟到补配、撤销重签、锁定前后释放、终态活动保护、本人最小快照、跨机构与参与者直读权限、审计 | 15 |
| `suite_trainings.py` | 聆听者培训体系：生命周期状态机、直连守卫（draft 强制/token 生成/写锁定）、签到资格（listener_not_approved）、开放/关闭分支、重复扫码幂等、补签/撤销原因必填+审计、撤销后可重签、me/trainings 聚合形态 | 48 |
| `suite_surveys.py` | 问卷四条件资格 AC-11 与答卷生命周期 AC-12/20：资格分因、草稿预填、提交幂等且内容不被覆盖、提交锁定、作废审计/统计排除/记录保留/不可重填 | 21 |
| `suite_exports.py` | 导出 AC-16/17：13 个 CSV 清单、BOM、manifest 行数一致、is_sensitive 过滤（非字段名）、作废排除、无用户名、二次确认、机构开关、超管豁免、审计 | 22 |
| `suite_auth.py` | 登录限流 AC-21 与账号规则 AC-06/02：用户名规则、大小写不敏感唯一、错密码不建重号、5 次失败触发 429 且限流期正确密码亦拒、邀请码一次性/撤销/过期/并发 | 19 |
| `suite_admin_email.py` | 管理员邮箱认证 AC-24（2026-08 改版）：注册必填邮箱（格式/查重/小写归一/verified=false）、邮箱+密码登录、找回门控（未验证静默 204 + suppressed 审计、已验证放行）、request-verification 限流 429、request-otp 可用（OTP 全链路属上线验收）、guards 禁直连改邮箱 | 15 |
| `suite_posts.py` | 内容推文 posts AC-25（2026-08 改版）：仅超管写（管理员/参与者/匿名 create/update/delete 全拒）、正文或外链至少其一与外链协议校验、published_at 只写一次、status 缺省 hidden、可见性矩阵、置顶排序、post.create/update 审计、公开读字段收敛 | 20 |
| `suite_outcome.py` | 公开 Outcome AC-26（2026-08 改版）：匿名 200 与响应形态；全平台累计口径的增量断言（机构 +1/停用回落、草稿不计、发布/关闭/归档计入、下架回落、有效签到 +1） | 10 |
| `suite_backup.py` | 备份告警 AC-23：backup/run 410 下线形态与不写审计、backup-status 无记录 alert=true、backup.* 审计聚合驱动告警/解除（超管直插模拟上报）、接口访问控制 | 10 |
| `suite_nodelete.py` | 无硬删除 AC-18：24 个可造 fixture 的业务集合（含 activity_pairs）delete 对管理员/参与者全拒、审计无创建/修改途径 | 29 |
| `suite_templates.py` | 超管模板管理 FR-SUR-001/011、PRD §11.3：新建模板+首版（事务回补循环引用）、发布新版本（version 递增、current_version_id 移动）、schema 校验与规范化、停用拒发、template.create/publish 审计、访问控制 | 20 |
| `suite_hardening.py` | 安全加固回归（2026-08）：直连写守卫矩阵（registrations/answers/sessions/activities/field_defs 非超管 403、超管放行）、账号停用不可自助复活、内置认证限流（5 连败→429）、CSV 公式注入中和与 export.download 审计、答案类型校验 400、QR 面（原生 view 404/公开端点不泄露 token/错误 token 404）、活动状态机补强（ACTIVITY_UNAVAILABLE/NOT_OPEN） | 27 |
| `suite_reports.py` | reports 报告集合（agent 产出物入库）：超管 multipart 创建带文件报告与字段回读、protected 文件无 token 访问被拒、机构管理员/参与者/匿名 create 与 list/view 全拒（rules 全 null）、report.upload 创建审计同事务写入 | 15 |

⚠️ **内置认证 per-IP 限流预算**：authguard.pb.js 对全部 `*/auth-with-password` 按来源 IP
限 25 次/10 分钟（含成功尝试，集成测试同积于 127.0.0.1；2026-08 改版由 20 上调）。
一轮全量运行共产生 22 次内置认证尝试：16 次登录（super_login 1 + 各套件管理员登录 13
+ suite_hardening fixture 1 + suite_admin_email 邮箱登录 1）+ suite_hardening 限流用例
6 次，**预算余量为 3**：新增套件的内置 auth-with-password 调用须控制在此预算内——
需要管理员登录态时优先用 `cc_fixture.create_admin_via_impersonate`（超管直建 +
impersonate，suite_trainings 即此模式），参与者一律走自定义端点 `/api/cc/auth/participant`；
且 suite_hardening 必须排最后执行，详见其头注释。

注：模板与版本集合的循环引用已可由 `POST /api/cc/super/templates` 事务端点创建
（super.pb.js，超管鉴权）；runner 的 SQL 直插 fixture 仍保留，作为不依赖业务端点的
平台级只读 fixture（套件隔离要求）。

### fixture 约定（test-plan §7）

- 平台级共享 fixture 由 runner 引导一次：标准报名字段（nickname 必填 / phone 敏感 /
  age / channel）+ 标准问卷模板首版（**SQL 直插**——模板与版本集合循环引用无法经
  API 创建，见 `integration/run.py` 头部注释）。
- 每个套件自建机构/管理员/活动/参与者，用户名与活动代码带套件前缀，套件间互不干扰，
  整仓可重复运行。
- 新增携带或可反查 `organization_id` 的接口时，**必须同 PR 在 `suite_acl.py` 补充越权
  用例**（test-plan §4 强制扩展规则）。

## 迁移冒烟（M0）

`migration_smoke.sh` — 空库 migrate up → 全部 down → 再 up 往返 + serve 后 API 抽查
（集合存在性、未认证拒绝、公开活动 viewRule、唯一索引、三角色隔离、无硬删除）。
用法：`bash backend/tests/migration_smoke.sh`。
