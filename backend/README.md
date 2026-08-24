# backend/ — PocketBase 后端

Chat Circles 后端为单个 PocketBase 实例：认证、业务 API、collection API rules、`pb_hooks` 服务端业务规则、SQLite 存储（technical-design §5.1）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `pb_migrations/` | 全部 schema 变更（集合、字段、索引、API rules），版本化管理。**schema 只能经迁移变更**，禁止在生产环境用 admin UI 手工改结构。当前含 22 个业务集合的 22 个 JS 迁移（按依赖顺序，`1785888000+` 时间戳前缀；最新 `1785889260` 追加 `registration_field_defs.role_scope` 与培训体系三集合），对应 database-design §5.2。 |
| `pb_hooks/` | 全部服务端业务规则（JS），按领域分文件（`auth.pb.js`、`registrations.pb.js` 等）。**0.28.4 JSVM 各 hooks 文件作用域完全隔离**，共享函数以 `lib/` 为契约标准源、在 handler 内内联（勿手工改副本）。 |
| `tests/` | 服务端测试：`integration/` 集成测试套件（L3，CI 必过）+ `migration_smoke.sh` 迁移冒烟，见下文「测试」。 |
| `scripts/` | 开发辅助脚本：`seed_demo.sh` 演示种子数据注入，见下文「演示种子数据」。 |
| `pb_public/` | 前端 build 产物放置处（部署期由 Docker 构建填充，PocketBase 同源伺服），不入库。 |

## 本地启动

1. 下载 PocketBase 二进制（版本与 CI/Docker 一致，见根目录 `.env.example` 的 `PB_VERSION`）：

   ```sh
   # macOS (Apple Silicon)；其他平台替换 darwin_arm64 为 linux_amd64 等
   curl -L -o /tmp/pb.zip \
     "https://github.com/pocketbase/pocketbase/releases/download/v0.28.4/pocketbase_0.28.4_darwin_arm64.zip"
   unzip /tmp/pb.zip -d backend/
   ```

2. 初始化并启动（在本目录 `backend/` 下执行）：

   ```sh
   # 首次或迁移有更新时：应用全部迁移（幂等）
   ./pocketbase migrate up --dir pb_data --migrationsDir pb_migrations --hooksDir pb_hooks

   # 首次：创建本地超级管理员（凭据仅本地开发用，不要复用到其他环境）
   ./pocketbase superuser create admin@cc.local '换成你自己的强密码' --dir pb_data

   # 启动
   ./pocketbase serve --dir pb_data --migrationsDir pb_migrations --hooksDir pb_hooks
   ```

   > ⚠️ **`--dir` / `--migrationsDir` / `--hooksDir` 必须显式传**：实测不传时
   > PocketBase 按默认位置解析，会加载到错误内容（hooks 不生效 / 用错数据目录）。
   > serve 不会再自动补跑迁移，先 `migrate up` 再 `serve`。

   - API 与前端静态资源：<http://127.0.0.1:8090>
   - 健康检查（hooks 自定义端点）：<http://127.0.0.1:8090/api/cc/health> → `{"ok":true}`
   - 管理后台：<http://127.0.0.1:8090/_/>

## 演示种子数据

```sh
bash backend/scripts/seed_demo.sh
```

对本地开发库注入演示数据（幂等，可重复执行）：两个演示机构（阿尔法：发布审核关/敏感导出开；贝塔：发布审核开/敏感导出关）、标准报名字段、**标准问卷模板首版**、每机构一名演示管理员（`adminalpha` / `adminbeta`，密码 `demo_admin_123`）、每机构一枚未使用邀请码（明文打印在输出末尾，供体验邀请码注册）、演示活动（已发布）、活动问卷（已开放）、演示参与者（`demo_speaker` / `demo_listener`，密码 `demo_user_123`，报名已通过）。

实现说明：模板因 `survey_templates.current_version_id ↔ survey_template_versions.template_id` 循环引用无法经 API 一次创建，脚本对模板首版使用 sqlite3 直插（`seed_demo.py --sql-fixture`，列名与迁移 1785888660 一致），其余数据全部走 API 注入；脚本自带临时 serve（默认端口 8096，注入完即停止），若已有 serve 占用同一数据目录请先停止。

## 测试

### 集成测试套件（L3，CI 必过）

```sh
bash backend/tests/run_integration.sh
```

一键自举临时 PocketBase 实例（临时数据目录 → 全部迁移 → 测试超管 → 模板 SQL fixture → 显式三目录参数 serve），执行 `tests/integration/` 下全部套件（共 399 项断言）：主链路 53 项、越权矩阵（AC-03）、名额硬校验与并发审核（AC-08）、状态迁移矩阵（AC-07）、签到唯一/幂等/补签撤销（AC-09/10/20）、聆听者培训体系（生命周期/签到资格/补签撤销/me 聚合）、问卷四条件与答卷生命周期（AC-11/12）、导出敏感过滤与开关（AC-16/17）、登录限流与邀请码（AC-21/02）、备份告警（AC-23）、无硬删除（AC-18）。输出逐条 PASS/FAIL 与汇总，任一失败退出码为 1。仅依赖 python3 标准库；端口可用 `CC_IT_PORT` 覆盖（默认 8097），`CC_IT_KEEP=1` 保留临时目录调试。详见 `tests/README.md`。

### 迁移冒烟验证

```sh
bash backend/tests/migration_smoke.sh
```

脚本使用临时数据目录（不污染 `pb_data/`）：空库 `migrate up` → 全部 `migrate down` → 再 `migrate up` 往返，随后启动 serve 抽查 22 个集合存在性、未认证访问拒绝、公开活动 viewRule、`registrations` 参与者×活动唯一索引、参与者/管理员/超管三类身份隔离与无硬删除。全部检查通过时退出码为 0。

## 不入库约定

以下内容由 `.gitignore` 排除，**不得提交**：

- `pocketbase` 二进制（按平台各自下载）
- `pb_data/`（SQLite 数据文件与上传文件）
- `pb_public/` 中的构建产物
