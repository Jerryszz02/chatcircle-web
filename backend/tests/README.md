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
| `suite_flow.py` | 主链路全链路（自 /tmp/cc_e2e.py 联调沉淀）：邀请码→建活动→报名→审核→签到→问卷→看板→导出→备份→未认证形态 | 42 |
| `suite_acl.py` | **越权矩阵 AC-03**（test-plan §4）：机构A管理员→机构B 活动/报名/答案/签到/场次/问卷/题目/答卷/答案/导出/审计/机构/账号的列表+详情，全部自定义端点，导出 scope 与看板参数伪造，横向：管理员→超管端点、参与者→管理端点与他人记录、未认证 | 68 |
| `suite_capacity.py` | 名额事务硬校验与并发审核 AC-08：角色/总名额满拒过、新报名口径、名额修改下限、审核改角色撞满、双管理员并发审核不超额 | 14 |
| `suite_transitions.py` | 状态迁移矩阵 AC-07：5 种合法迁移 + 7 种非法组合枚举、原因必填、审计留痕（操作者/前后状态/原因）、回退重校验名额、同态幂等 | 19 |
| `suite_checkins.py` | 签到 AC-09/10/20：前置校验分支、重复扫码幂等、并发双扫一人一签、补签/撤销原因必填+审计、撤销保留记录、口径同步 | 23 |
| `suite_surveys.py` | 问卷四条件资格 AC-11 与答卷生命周期 AC-12/20：资格分因、草稿预填、提交幂等且内容不被覆盖、提交锁定、作废审计/统计排除/记录保留/不可重填 | 21 |
| `suite_exports.py` | 导出 AC-16/17：13 个 CSV 清单、BOM、manifest 行数一致、is_sensitive 过滤（非字段名）、作废排除、无用户名、二次确认、机构开关、超管豁免、审计 | 22 |
| `suite_auth.py` | 登录限流 AC-21 与账号规则 AC-06/02：用户名规则、大小写不敏感唯一、错密码不建重号、5 次失败触发 429 且限流期正确密码亦拒、邀请码一次性/撤销/过期/并发 | 19 |
| `suite_backup.py` | 备份告警 AC-23：成功无告警、故障注入后 alert=true、backup.success/failed 审计、恢复后解除、接口访问控制 | 11 |
| `suite_nodelete.py` | 无硬删除 AC-18：19 个业务集合 delete 对管理员/参与者全拒、审计无创建/修改途径 | 24 |

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
