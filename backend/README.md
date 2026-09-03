# backend/ — PocketBase 后端

Chat Circles 后端为单个 PocketBase 实例：认证、业务 API、collection API rules、`pb_hooks` 服务端业务规则、SQLite 存储（technical-design §5.1）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `pb_migrations/` | 全部 schema 变更（集合、字段、索引、API rules），版本化管理。**schema 只能经迁移变更**，禁止在生产环境用 admin UI 手工改结构。当前含 26 个业务/内部集合的 28 个 JS 迁移；T2 的 `1787880000` 增加现场字段与 `activity_pairs`，T1 的 `1787895000` 增加参与者手机号字段与内部 challenge 集合。 |
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

## 参与者手机号认证

T1 使用阿里云号码认证服务 `Dypnsapi` 的 `SendSmsVerifyCode` / `CheckSmsVerifyCode`。本地启动前至少配置：

```sh
export CC_ENVIRONMENT=development
export CC_SMS_PROVIDER=aliyun
export CC_PHONE_HASH_KEY='替换为至少32字符的独立随机密钥'
export ALIBABA_CLOUD_ACCESS_KEY_ID='从部署环境注入'
export ALIBABA_CLOUD_ACCESS_KEY_SECRET='从部署环境注入'
export CC_SMS_SIGN_NAME='控制台中的短信认证签名'
export CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE='100001 登录/注册模板'
export CC_SMS_TEMPLATE_BIND_NEW_CODE='100004 绑定新手机号模板'
export CC_SMS_TEMPLATE_VERIFY_BOUND_CODE='100005 验证绑定手机号模板'
```

短信按业务场景选择模板：登录/注册用 `CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE`，首次绑定与换绑新号用 `CC_SMS_TEMPLATE_BIND_NEW_CODE`，换绑时验证当前旧号用 `CC_SMS_TEMPLATE_VERIFY_BOUND_CODE`。`CC_SMS_TEMPLATE_CODE` 仅为迁移期兼容，新代码不再读取。

完整手机号只写入 `participant_accounts.phone_e164` 隐藏字段，精确查找使用带部署密钥的 HMAC；验证码和完整手机号不写 challenge、日志或审计。`CC_SMS_PROVIDER=mock` 只供自动化测试，且在 `CC_ENVIRONMENT=production` 下会被服务端拒绝。

## 测试

### 集成测试套件（L3，CI 必过）

```sh
bash backend/tests/run_integration.sh
```

一键自举临时 PocketBase 实例并执行全部套件（535 项断言），覆盖既有主链路、越权、并发、导出与审计回归，以及 T1 手机号认证、T2 现场编号与配对、T3 实时汇总与 Realtime 权限。任一失败退出码为 1；仅依赖 python3 标准库。端口可用 `CC_IT_PORT` 覆盖（默认 8097），`CC_IT_KEEP=1` 保留临时目录调试。详见 `tests/README.md`。

### 迁移冒烟验证

```sh
bash backend/tests/migration_smoke.sh
```

脚本使用临时数据目录（不污染 `pb_data/`）：空库 `migrate up` → seed 及其后续迁移局部回滚 → 全部 `migrate down` → 再 `migrate up` 往返，随后启动 serve 抽查 26 个业务/内部集合、权限、唯一索引、三类身份隔离与无硬删除（62 项检查）。全部检查通过时退出码为 0。

## 邮件（SMTP）配置（2026-08 改版）

管理员邮箱能力（注册验证、OTP 验证码登录、密码找回，AC-24）全部由 PocketBase 内置端点承载，**投递依赖手工配置 SMTP**（PocketBase 无托管邮件服务）：

1. 管理后台 `/_/` → Settings → Mail settings：填入发信邮箱的 SMTP 主机/端口/账号/密码与 Sender 地址（凭据只存部署环境，**不入库、不进文档**，technical-design 待确认 #18）。
2. Settings → Application：确认 App URL 指向站点地址（邮件链接以其为前缀）。
3. 邮件模板（Settings → Mail templates）中验证/找回链接须指向前端落地页路由（待确认 #19，前端页面落地后配置）。

未配置 SMTP 时：注册等主流程不受影响；request-verification / request-password-reset / request-otp 端点仍正常受理（返回 204/200），仅实际发信失败并记录在服务端日志。测试环境不配 SMTP，套件只断言端点行为与数据终态、不断言投递。

## 不入库约定

以下内容由 `.gitignore` 排除，**不得提交**：

- `pocketbase` 二进制（按平台各自下载）
- `pb_data/`（SQLite 数据文件与上传文件）
- `pb_public/` 中的构建产物
