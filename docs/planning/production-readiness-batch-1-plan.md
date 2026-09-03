# ChatCircle 上线前第一批整改计划

> 状态：`计划中`
>
> 适用基线：`origin/main@05411bf34d81019b58f7c3c1b73b0f67272e72d1`
>
> 规划/审计日期：2026-09-03
>
> 用途：交给实现者（包括外部开发 agent）分批完成上线前第一批代码闭环。本文件描述目标与验收要求，不代表相关改动已经实现、验证或部署。

## 1. 目标

本批次闭环以下事项：

1. 修复部署完成后的健康检查，使其不依赖生产已移除的宿主机 `8090` 端口映射。
2. 让登录/注册、首次绑定、换绑旧号验证、换绑新号验证使用语义正确的阿里云短信认证模板。
3. 增加生产短信环境变量预检，在更新生产代码前拦截缺失配置。
4. 修复管理员邀请码注册页面未提交后端必填邮箱的问题。
5. 同步本批次涉及的公众 README、开发者指南、部署手册和规划文档。
6. 修复当前 production dependency 安全公告，并增加持续审计门禁。

建议拆成三个独立 PR，依次合并。每个 PR 必须从当时最新的 `origin/main` 新建分支，分支名遵循仓库全局 Git 规则 `<type>/<kebab-case 简述>-<YYYYMMDD>`（type 与该 PR 主 commit 一致）；不得在默认分支直接开发，不得自动合并。

## 2. 非目标

- 不在本批次办理或自动化网站备案；备案完成后的正式 `443` 切换继续按 `deploy/README.md` 执行。
- 不在代码、Git、PR、CI 日志或对话中保存真实 AccessKey、签名名称、SMTP 密码或 `.env` 内容。
- 不在 CI 中调用真实阿里云短信接口或产生短信费用。
- 不改变参与者手机号认证 HTTP API 的请求/响应形状。
- 不改变现有账号合并、手机号冲突和双验证码原子换绑规则。
- 不在本批次强制管理员验证邮箱后才能登录；SMTP、邮箱 OTP、验证邮件和密码找回前端闭环另立任务。
- 不进行 PocketBase、React、Vite 等无关的大版本升级，也不顺手重构路由架构。

## 3. 当前证据与差距

以下为 2026-09-03 对上述基线的静态检查和本次命令结果；状态仅代表当前默认分支，不代表生产已经修复。

| 事项 | 当前证据 | 状态 |
|---|---|---|
| 部署健康检查 | `docker-compose.yml` 不发布 app 的 `8090`；`.github/workflows/deploy.yml` 仍请求宿主机 `127.0.0.1:8090/api/health` | `计划中`：确定性配置错配 |
| 短信模板 | `backend/pb_hooks/phoneauth.pb.js` 的 `sendCode()` 只读取 `CC_SMS_TEMPLATE_CODE` | `计划中`：所有业务场景共用一个模板 |
| 短信生产凭据 | 部署负责人提供的脱敏容器检查显示 AccessKey ID/Secret 未设置，签名和旧单模板变量已设置 | `待确认`：需负责人在 ECS 写入新变量后才能真机验证 |
| 管理员注册 | 后端 `auth.pb.js` 强制 email；前端 `AdminRegisterPage.tsx` 和 `registerAdmin()` 未收集/提交 email | `计划中`：网页注册必然得到 `INVALID_EMAIL` |
| 文档 | 根 README 仍称参与者无需手机号/邮箱；开发者指南仍称生产 app 绑定回环 `8090` | `计划中`：与当前代码不一致 |
| 前端依赖 | `npm audit --omit=dev`：2 个 moderate；lockfile 实际解析 `react-router-dom/react-router=6.30.4`（`package.json` 声明 `^6.28.0`，实际以 lockfile 为准） | `计划中` |
| MCP 依赖 | `npm audit --omit=dev`：`qs@6.15.3` 含 2 个 moderate advisory | `计划中` |
| CI 审计 | `ci.yml` 未运行 production dependency audit | `计划中` |

## 4. 已确定的实现决策

### 4.1 短信模板映射

当前换绑流程要求旧手机号和新手机号分别获取并核验验证码，因此按每条短信的实际用途选择模板：

| 产品场景 | 内部判定 | 阿里云赠送模板 |
|---|---|---|
| 手机号登录或自动注册 | `purpose=login_or_register` | `100001` 登录/注册模板 |
| 存量用户名账号首次绑定手机号 | `purpose=bind_phone` | `100004` 绑定新手机号模板 |
| 换绑时验证当前手机号 | `purpose=change_phone, changeRole=old` | `100005` 验证绑定手机号模板 |
| 换绑时验证新手机号 | `purpose=change_phone, changeRole=new` | `100004` 绑定新手机号模板 |

本批次不使用：

- `100002` 修改绑定手机号模板：它是通用换绑描述，但当前产品会分别向旧号和新号发送验证码，使用 `100005`/`100004` 能准确说明每条短信的目的。
- `100003` 重置密码模板：参与者以短信验证码登录，不存在参与者短信重置密码流程。

> 模板 CODE 与内容按阿里云控制台**赠送模板**核对无误（2026-09-03 控制台截图）：四个模板的验证码变量均为 `${code}`、有效期变量均为 `${min}`，与 `sendCode()` 现有 `TemplateParam = { code: '##code##', min: ... }` 完全一致，故无需按模板区分发送参数，CODE 作为本批次固定实现常量。

阿里云号码认证服务的赠送签名必须与赠送模板搭配；`SchemeName` 是可选参数，不传时使用默认方案。实现与联调应以以下官方资料为准：

- [短信认证服务说明](https://help.aliyun.com/zh/pnvs/user-guide/sms-authentication-service)
- [SendSmsVerifyCode API](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode)

### 4.2 新短信配置契约

以三个语义变量替代生产环境的旧单模板变量：

```env
CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE=100001
CC_SMS_TEMPLATE_BIND_NEW_CODE=100004
CC_SMS_TEMPLATE_VERIFY_BOUND_CODE=100005
```

生产环境使用 `CC_SMS_PROVIDER=aliyun` 时必须非空：

```text
ALIBABA_CLOUD_ACCESS_KEY_ID
ALIBABA_CLOUD_ACCESS_KEY_SECRET
CC_SMS_SIGN_NAME
CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE
CC_SMS_TEMPLATE_BIND_NEW_CODE
CC_SMS_TEMPLATE_VERIFY_BOUND_CODE
```

以下保持可选：

```text
ALIBABA_CLOUD_SECURITY_TOKEN  # 仅 STS 临时凭据需要
CC_SMS_SCHEME_NAME            # 不填时使用阿里云默认方案
```

`CC_SMS_TEMPLATE_CODE` 可为迁移期保留非生产兼容，但生产预检不得用它替代上述场景变量，否则仍可能让所有场景静默共用一个模板。`docker-compose.yml` 在迁移期仍保留传入 `CC_SMS_TEMPLATE_CODE`（对旧版本/回滚无副作用），但新后端代码（§5.3）不再读取它，也不以它作为预检依据；真机验收通过后可由负责人从生产 `.env` 移除。

### 4.3 管理员邮箱注册边界

本批次只对齐已经存在的后端契约：注册页增加必填 email、归一化后提交，注册成功仍使用用户名和密码直接登录。不得顺带增加“必须完成邮箱验证才能登录”的门槛；后者需要 SMTP、邮件模板、验证页面和运营流程共同决策。

### 4.4 依赖审计边界

- 只处理 `npm audit --omit=dev` 当前报告的 production dependency 公告。
- 审计阈值为 `moderate`，不得通过调高阈值、`continue-on-error` 或 `|| true` 隐藏问题。
- 不使用未经审查的 `npm audit fix --force`。
- 锁文件必须提交，以保证本地、CI 和镜像构建解析到同一版本。

## 5. PR 1：部署健康检查与短信生产闭环

### 5.1 Git 信息

```text
branch: fix/deploy-sms-readiness-20260903
commit: fix(deploy): validate SMS configuration and container health
PR:     fix(deploy): validate SMS configuration and container health
```

### 5.2 修复部署健康检查

主要文件：

```text
.github/workflows/deploy.yml
deploy/release-config-checks.mjs
deploy/verify-release-config.mjs
deploy/verify-release-config.test.mjs
```

要求：

1. `docker compose up --build -d` 后获取 `docker compose ps -q app`。
2. 最多等待约 90 秒，轮询 `docker inspect` 的 `.State.Health.Status`。
3. 只有 `healthy` 才成功；容器不存在、退出、`unhealthy` 或超时均失败。
4. 失败时输出 `docker compose ps` 和 `docker compose logs --tail=120 app`。
5. 不为修检查重新发布宿主机 `8090`，也不把 debug override 变成生产默认配置。
6. 更新静态发布配置检查，使其要求部署步骤中存在活动的容器健康检查；注释中的命令或放错步骤的命令不能通过。

> 判定语义：compose 的 healthcheck（`start_period=10s`/`interval=10s`/`retries=12`）理论上约 140s 才把坏容器标记为 `unhealthy`，在 90 秒等待窗口内它通常仍处于 `starting`。因此判定标准是「90 秒内未达 `healthy` 即失败」，并非等待 `unhealthy` 判定。

优先复用 `docker-compose.yml` 已声明的 app healthcheck。无需从宿主机再次请求已不可达的 `127.0.0.1:8090`。

### 5.3 后端模板选择

主要文件：

```text
backend/pb_hooks/phoneauth.pb.js
```

要求：

1. 增加显式模板选择函数，例如 `selectTemplateCode(purpose, changeRole)`。
2. `sendCode()` 接收 `purpose` 和 `changeRole`，按 §4.1 映射。
3. 未知组合必须返回稳定的 provider/configuration 错误，不能回落到登录模板。
4. Mock provider 不得调用真实阿里云；生产 `aliyun` 使用选定模板调用 `SendSmsVerifyCode`。
5. 保持现有 `CheckSmsVerifyCode`、验证码生命周期、限流、隐私同意和 challenge 状态机不变。
6. 不把完整手机号、验证码、AccessKey 或密钥写进日志、响应、审计或新增持久化字段。
7. 保持外部错误仍归一为 `provider_unavailable` 等现有业务语义。

PocketBase hook 的顶层作用域不能跨文件共享；不要为复用模板选择函数引入不受支持的跨 hook import。

### 5.4 Compose、示例配置与生产预检

主要文件：

```text
docker-compose.yml
.env.example
.github/workflows/deploy.yml
deploy/release-config-checks.mjs
deploy/verify-release-config.mjs
deploy/verify-release-config.test.mjs
backend/README.md
deploy/README.md
docs/release-checklist.md
docs/planning/account-event-workflow-prd.md
docs/planning/technical-design.md
docs/planning/api-design.md
docs/planning/README.md
```

要求：

1. 将三个新模板变量传入 app 容器，并在 `.env.example` 写占位和场景说明。
2. 当 `CC_ENVIRONMENT=production` 且 `CC_SMS_PROVIDER=aliyun` 时，部署预检检查 §4.2 的全部必填变量。
3. 只输出缺失的变量名，绝不能输出变量值。
4. 本地/CI 的 mock provider 不得因缺少真实阿里云凭据而失败。
5. 保留现有 `CC_PHONE_HASH_KEY >= 32` 检查。
6. 检查变量已实际传入候选 app 容器，而不仅是 `.env.example` 中存在。
7. `ALIBABA_CLOUD_SECURITY_TOKEN` 和 `CC_SMS_SCHEME_NAME` 缺失不得阻止部署。

### 5.5 测试

主要文件：

```text
backend/tests/integration/suite_phone_auth.py
deploy/verify-release-config.test.mjs
```

至少覆盖：

- 登录/注册选择登录模板。
- 首次绑定选择绑定新手机号模板。
- 换绑旧号选择验证绑定手机号模板。
- 换绑新号选择绑定新手机号模板。
- 未知 `purpose/changeRole` 不静默使用其他模板。
- 缺少任一生产必填变量时预检失败。
- 缺少 STS token 或 scheme 时预检仍通过。
- 原有登录、幂等建号、冲突、旧号/新号双验证码原子换绑和 provider 失败测试继续通过。
- 测试不得访问真实阿里云；如需观测 mock 选择结果，只允许使用不含手机号和 secret 的测试标记。

### 5.6 PR 1 验证

```bash
node --check backend/pb_hooks/phoneauth.pb.js
node deploy/verify-release-config.mjs
node --test deploy/verify-release-config.test.mjs
bash backend/tests/run_integration.sh
git diff --check
```

### 5.7 发布顺序与回滚

合并 PR 1 前，部署负责人必须先在 ECS `/opt/chatcircle/.env` 写入新变量。旧版本会忽略这些额外变量，因此可安全预置；不得把值发给实现者。

如果新版本部署失败：

1. 保留失败日志和缺失变量名。
2. 不通过恢复公网 `8090` 绕过健康检查。
3. 修正 `.env` 后重新触发同一版本部署；代码回滚只通过正常 Git PR/commit 完成。
4. 旧 `CC_SMS_TEMPLATE_CODE` 在新场景变量完成真机验证前暂不从服务器删除；但新生产代码不得依赖它。

## 6. PR 2：管理员邮箱注册与文档漂移

### 6.1 Git 信息

```text
branch: fix/admin-email-registration-20260903
commit: fix(auth): collect email during admin registration
PR:     fix(auth): collect email during admin registration
```

### 6.2 前端契约修复

主要文件：

```text
frontend/src/features/admin/pages/AdminRegisterPage.tsx
frontend/src/shared/api/http.ts
```

要求：

1. 注册页增加必填邮箱输入框：`type=email`、`autoComplete=email`、最大 254 字符。
2. 提交前执行 `trim().toLowerCase()`。
3. 前端邮箱格式检查与后端当前简版规则保持一致；前端校验仅改善体验，后端仍为权威。
4. `registerAdmin()` 输入类型加入 `email: string`。
5. 请求体必须包含 `invite_code`、`username`、`email`、`password`。
6. 保持注册成功后以用户名/密码登录并进入 `/admin/activities`。
7. 不在日志或错误上报中打印完整注册请求。

### 6.3 前端测试

新增：

```text
frontend/src/features/admin/pages/AdminRegisterPage.test.tsx
```

至少覆盖：

- 显示必填邮箱字段。
- 合法邮箱 trim 并转小写后提交。
- 空邮箱和非法邮箱不请求后端。
- 密码不一致仍被拦截。
- 正常请求四个字段齐全。
- 注册成功后调用登录并跳转管理端。
- `EMAIL_TAKEN`、`INVALID_EMAIL` 等后端错误的 message 文案能显示给用户（复用 `normalizeApiError` 现有实现，只依赖后端返回 `message`；前端不需要识别业务 code，故不扩展错误码类型）。

后端 `backend/tests/integration/suite_admin_email.py` 已覆盖 email 必填、格式、归一化、重复值与匿名响应不泄露 email；不得削弱这些断言。

### 6.4 文档同步

主要文件：

```text
README.md
docs/developer-guide.md
docs/release-checklist.md
docs/planning/technical-design.md
docs/planning/security-privacy.md
docs/planning/README.md
```

> 注：`AdminRegisterPage.tsx` 与 `http.ts` 属 §6.2 的代码改动，其注释/契约说明随 §6.2 一并更新，此处不重复列出。

要求：

- 根 README 不再称参与者注册只需用户名和密码或完全不需要手机号。
- 明确参与者主入口是手机号验证码；机构管理员邀请码注册需要用户名、邮箱和密码。
- `/admin/register` 路由、页面和 API 注释补齐 email。
- 管理员邮箱验证、OTP 和找回能力继续如实标记为依赖 SMTP 的未闭环项。
- `docs/developer-guide.md` 改为：生产基础 compose 不发布 app 端口，只在 Docker 私网供 Caddy/backup 使用；显式叠加 `deploy/docker-compose.debug.yml` 才发布回环 `8090`。
- 搜索并修复本批次相关的同义旧描述，不能只在文件末尾追加一段“最新说明”。
- 测试数量若继续写入文档，必须以本 PR 实际执行结果为准；未执行时不要声称通过。

### 6.5 PR 2 验证

```bash
npm run lint --prefix frontend
npm run typecheck --prefix frontend
npm run test --prefix frontend
npm run build --prefix frontend
bash backend/tests/run_integration.sh
git diff --check
```

## 7. PR 3：生产依赖修复与审计门禁

### 7.1 Git 信息

```text
branch: ci/dependency-audit-20260903
commit: ci(security): audit production dependencies
PR:     ci(security): audit production dependencies
```

### 7.2 前端 React Router

当前版本：

```text
react-router-dom 6.30.4
react-router     6.30.4
```

本次 `npm audit fix --dry-run` 显示 `6.30.6` 只能修复部分公告，仍会留下 `react-router <7.18.0` 的 moderate。目标是评估并升级到当前已验证可修复公告的 `react-router-dom 7.18.3`，而不是只把直接依赖升到 `6.30.6` 后宣称审计已闭环。

主要文件：

```text
frontend/package.json
frontend/package-lock.json
```

要求：

- 保持 React 18，除非安装或编译证据证明必须调整。
- CI 和 Docker 已使用 Node 22；保持这一前提。
- 重点回归 `BrowserRouter`、`Routes`、`Navigate`、`Link`、`NavLink`、`useNavigate`、`useSearchParams`。
- 保留 `sanitizeRedirect()` 对站外 URL、反斜杠、控制字符和登录循环的防护测试。
- 如果 v7 迁移产生兼容问题，只做必要适配，不重构整个路由架构。

### 7.3 MCP 的 `qs`

当前依赖链：

```text
@modelcontextprotocol/sdk@1.30.0
  -> express@5.2.1
    -> qs@6.15.3
```

安全版本为 `qs@6.16.0`。若上游依赖仍未更新，在 `mcp/package.json` 增加明确 override，并重新生成锁文件：

```json
{
  "overrides": {
    "qs": "6.16.0"
  }
}
```

要求：

- `npm ls qs` 最终解析到安全版本。
- `npm run selftest --prefix mcp` 通过。
- 不升级无关 MCP 依赖。

### 7.4 CI 与发布审计门禁

主要文件：

```text
.github/workflows/ci.yml
scripts/t7-release-acceptance.sh
frontend/package.json
frontend/package-lock.json
mcp/package.json
mcp/package-lock.json
docs/planning/test-plan.md
docs/planning/README.md
```

建议在 CI 增加独立、可设为 required check 的 `dependency-audit` job：

```bash
npm ci --prefix frontend
npm audit --prefix frontend --omit=dev --audit-level=moderate

npm ci --prefix mcp
npm audit --prefix mcp --omit=dev --audit-level=moderate
npm run selftest --prefix mcp
```

要求：

- 只审计 production dependencies。
- moderate、high、critical 都必须导致失败。
- 不使用 `continue-on-error`、`|| true` 或更高阈值绕过。
- 将相同审计加入 `scripts/t7-release-acceptance.sh`。
- 文档说明审计需要 npm registry 网络，新增公告可能让未来构建失败，这是安全门禁的预期行为。
- 如果 GitHub 仓库启用了 required checks，仓库管理员需把 `dependency-audit` 加入必过列表；代码无法替代该仓库设置。

### 7.5 PR 3 验证

```bash
npm run lint --prefix frontend
npm run typecheck --prefix frontend
npm run test --prefix frontend
npm run build --prefix frontend
npm audit --prefix frontend --omit=dev --audit-level=moderate

npm run selftest --prefix mcp
npm ls qs --prefix mcp
npm audit --prefix mcp --omit=dev --audit-level=moderate

bash scripts/t7-release-acceptance.sh
git diff --check
```

如果完整发布验收未包含或未成功启动 E2E，则单独执行并如实记录：

```bash
npm test --prefix e2e -- --project=chromium
```

## 8. 生产负责人操作

这些操作需要阿里云账号、服务器权限、真实手机号或仓库设置权限，不能由纯代码 PR 完成。

### 8.1 PR 1 合并前

在 ECS `/opt/chatcircle/.env` 写入：

```env
ALIBABA_CLOUD_ACCESS_KEY_ID=<RAM AccessKey ID>
ALIBABA_CLOUD_ACCESS_KEY_SECRET=<RAM AccessKey Secret>
CC_SMS_SIGN_NAME=<控制台赠送签名名称>
CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE=100001
CC_SMS_TEMPLATE_BIND_NEW_CODE=100004
CC_SMS_TEMPLATE_VERIFY_BOUND_CODE=100005
```

可继续不填：

```env
ALIBABA_CLOUD_SECURITY_TOKEN=
CC_SMS_SCHEME_NAME=
```

建议 RAM 自定义权限至少包含：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dypns:SendSmsVerifyCode",
        "dypns:CheckSmsVerifyCode"
      ],
      "Resource": "*"
    }
  ]
}
```

生产负责人还需：

- 完成阿里云实名认证并开通号码认证服务。
- 确认账户余额或套餐可用。
- 选择可与赠送模板搭配的系统赠送签名。
- 在控制台绑定测试手机号。
- 不把 AccessKey 发给实现者或写进 Git。

### 8.2 PR 1 部署后真机验收

用受控测试账号/号码分别验证：

1. `100001`：未注册手机号登录/注册，随后已注册手机号再次登录。
2. `100004`：存量用户名账号首次绑定手机号。
3. `100005`：换绑流程向当前旧手机号发送验证短信。
4. `100004`：同一换绑流程向新手机号发送绑定短信。
5. 旧号、新号验证码均正确时原子换绑成功，`participant_id` 和历史记录不变。
6. 错码、过期码、重复使用、冲突手机号继续按现有规则失败。

记录发送时间、场景、模板 CODE、阿里云请求 ID 和结果；不要记录完整手机号、验证码或 AccessKey。

### 8.3 PR 3 合并后

- 在 GitHub 仓库设置中将 `dependency-audit` 加入 required checks（如果当前套餐和规则集支持）。
- 确认 PR 不能在审计失败时合并。

## 9. 最终完成定义

本计划只有同时满足以下条件才可标记为 `已验证`：

- 三个 PR 均已从当时最新 `origin/main` 创建、完成审核并通过 required checks。
- 宿主机没有 `8090` 映射时，部署健康检查可以正确成功；app 异常时可以正确失败并输出诊断。
- 生产缺少任一必需短信变量时，更新生产代码前即被拦截，日志不泄露变量值。
- 四类短信发送按 §4.1 使用正确模板，真实测试手机号完成收发与核验。
- 管理员邀请码注册页提交 email，不再触发确定性的 `INVALID_EMAIL`。
- frontend 和 mcp 的 `npm audit --omit=dev --audit-level=moderate` 均为 0。
- 前端 lint、typecheck、unit、build，MCP selftest，迁移、后端集成和 E2E 均通过。
- 根 README、开发者指南、部署手册、发布清单和 planning 文档与最终实现一致。
- 仓库和 CI 日志中没有真实 `.env`、AccessKey、验证码、完整手机号或其他 secret。

只有代码合并但未完成 ECS 配置、真机短信和部署验证时，应标记为 `已实现未验证`，不得称为 production ready。

## 10. 待确认项

| 事项 | 当前处理 | 重新决策触发条件 |
|---|---|---|
| 是否使用 `100002` 修改绑定手机号模板 | 本批次不使用；旧号 `100005`、新号 `100004` | 产品改成单验证码换绑或阿里云联调证明双验证码必须使用通用模板 |
| 管理员是否必须验证邮箱后才能登录 | 不改变当前直接登录行为 | SMTP、邮件模板、验证页和运营处理流程确定后 |
| 管理员邮箱 OTP/找回页面 | 不纳入本批次 | SMTP 可用并明确用户流程后 |
| GitHub required check 是否可配置 | 由仓库管理员确认 | PR 3 创建 `dependency-audit` job 后 |
| 生产短信是否使用 STS | 默认长期 RAM AccessKey，不填 security token | 运维决定采用临时凭据和自动轮换后 |
