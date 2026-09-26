# Chat Circles 生产部署手册（M5）

> 当前生产基线：`chatcircle.empact.cn` 已完成 ICP 备案，正式入口使用标准 TCP 80/443。
> Caddy 负责 Automatic HTTPS 与反向代理；未备案时期的 `:8443 + DNS-01 + ALIYUN_ACCESS_KEY_*` 已退出正式架构。

## 1. 部署拓扑

```text
浏览器
  │ HTTP 80 / HTTPS 443
  ▼
Caddy（Automatic HTTPS、HTTP→HTTPS、按路径反向代理）
  │ Docker 私网
  ├─ 公开路由 → public-web:3100（公开页 SSR：/、/about、/privacy、/activities、
  │             /activities/past、/a/:id、/posts/:id、/public-assets/*、
  │             /robots.txt、/sitemap.xml、未知路径真实 404；无密钥、不挂 pb_data）
  └─ 功能路由 → app:8090（PocketBase：/api/*、SPA 构建资源 /assets/*、
                功能 SPA /login /me /admin/* /super/* /a/:id/register 等）
    │
    ├─ pb_data 持久化卷
    └─ backup 服务每日一致性备份 → backups 卷
```

生产基础 Compose **不向宿主机发布 PocketBase 8090**；只有 Caddy/backup/public-web 通过 Docker 私网访问 `app:8090`。public-web 同样不发布 host 端口，只被 Caddy 访问。需要本机调试时才显式叠加 `deploy/docker-compose.debug.yml`。

## 2. 生产环境变量

真实 `.env` 只保存在 ECS `/opt/chatcircle/.env`，不得提交 Git。

首次部署：

```bash
cp .env.example .env
chmod 600 .env
```

至少配置：

```env
CC_ENVIRONMENT=production
CC_SMS_PROVIDER=aliyun
CC_PHONE_HASH_KEY=<至少32字符的稳定随机密钥>

ALIBABA_CLOUD_ACCESS_KEY_ID=<号码认证 RAM AccessKey ID>
ALIBABA_CLOUD_ACCESS_KEY_SECRET=<号码认证 RAM AccessKey Secret>
CC_SMS_SIGN_NAME=<阿里云短信签名>
CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE=100001
CC_SMS_TEMPLATE_BIND_NEW_CODE=100004
CC_SMS_TEMPLATE_VERIFY_BOUND_CODE=100005

PB_SUPERUSER_EMAIL=<生产超管邮箱>
PB_SUPERUSER_PASSWORD=<生产超管密码>
```

`ALIBABA_CLOUD_SECURITY_TOKEN` 仅在使用 STS 临时凭据时填写；`CC_SMS_SCHEME_NAME` 可选。

旧 `CC_SMS_TEMPLATE_CODE` 仅为迁移兼容变量，新后端不再读取。

首次创建全新 `pb_data` 卷时，环境变量本身不会自动创建 PocketBase `_superusers` 账号。应用启动后必须执行一次：

```bash
docker compose up --build -d
docker compose exec app ./pocketbase superuser create \
  "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" \
  --dir /pb/pb_data
```

已有生产数据卷且超级管理员已经存在时不要重复创建；这一步只用于首次初始化。该账号同时用于 `/super` 与 `backup` 服务认证，所以漏掉会导致超级管理端无法登录、定时备份认证失败。

**不再需要：**

```env
ALIYUN_ACCESS_KEY_ID=...
ALIYUN_ACCESS_KEY_SECRET=...
```

这两个变量只服务于未备案时期 Caddy DNS-01 临时方案。完成本次 443 切换并验证成功后可从生产 `.env` 删除。

## 3. ICP 备案完成后的 8443 → 80/443 切换

### 3.1 合并正式 443 配置前必须完成

1. `chatcircle.empact.cn` 的 DNS A/AAAA 记录必须指向目标 ECS。
2. 阿里云 ECS 安全组放行入方向 TCP **80** 和 **443**。
3. 如主机启用了 firewalld/iptables，同样允许 80/443。
4. 确认宿主机没有其他进程占用 80/443：

```bash
ss -lntp | grep -E ':(80|443)\s' || true
```

5. 删除未备案时期遗留的服务器侧 Compose override。先备份：

```bash
cd /opt/chatcircle
if [ -f docker-compose.override.yml ]; then
  cp docker-compose.override.yml ~/docker-compose.override.yml.pre-443
  rm docker-compose.override.yml
fi
```

新的 Deploy workflow 对 `/opt/chatcircle/docker-compose.override.yml` **fail-closed**；该文件仍存在时不会修改生产版本。

### 3.2 正式部署

PR 合并到 `main` 后 GitHub Actions 自动：

1. SSH 到 ECS，只执行 `git fetch`；
2. 在临时 detached worktree 复制生产 `.env`；
3. `docker compose config -q`；
4. 只预拉取 Caddy；backup 与 public-web 使用本提交的构建上下文；
5. 构建候选镜像；
6. 构建后用无网络、无卷、无凭据的 smoke 启动候选 backup 镜像，并验证故意损坏脚本会变为 unhealthy；
7. 同样以无网络、无上游 smoke 验证候选 public-web 镜像（降级 200/503、robots、真实 404）；
8. 检查 `CC_PHONE_HASH_KEY >= 32` 和 production+aliyun 短信必填变量；
9. 等待当前 backup runtime 就绪并执行一次成功备份；
10. 上述门禁全部通过后才 fast-forward `/opt/chatcircle/main`；
11. `docker compose up --no-build --pull never -d`，只使用预检构建的候选镜像；随后 `caddy reload` 让按提交绑定的 Caddyfile 立即生效（bind mount 的纯内容变更不会触发容器重建）；
12. 轮询 app、backup 与 public-web 容器 healthcheck，90 秒内必须进入 `healthy`，并核对镜像 revision；
13. 线上门禁：`/api/cc/health` 200；首页原始 HTML 含 `rel="canonical"` 与 `__CC_PUBLIC_DATA__`（证明经 public-web SSR 而非 SPA 空壳）；`/robots.txt` 200 且含 Sitemap 行。

缺 Secret、Compose 配置错误、镜像拉取失败或 build 失败都会发生在生产工作区更新之前。

### 3.3 部署后验证

```bash
cd /opt/chatcircle
docker compose ps
docker compose logs --tail=100 caddy
```

外部验证：

```bash
curl -I http://chatcircle.empact.cn
curl -I https://chatcircle.empact.cn
curl -fsS https://chatcircle.empact.cn/api/health
```

预期：

- HTTP 自动跳转 HTTPS；
- HTTPS 不需要 `:8443`；
- `/api/health` 正常；
- `docker compose ps` 中 app 为 healthy、caddy 正常运行；
- Caddy 日志没有持续的 ACME/证书错误。

确认 443 正常后：

- 从阿里云安全组关闭旧的 TCP 8443 入站规则；
- 删除 `.env` 中旧 `ALIYUN_ACCESS_KEY_ID/SECRET`；
- 保留短信使用的 `ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET`，两者不是同一组变量。

## 4. Caddy / HTTPS

生产 Compose 使用官方 `caddy:2-alpine`，发布：

```text
80:80
443:443
```

`deploy/Caddyfile` 的站点地址是：

```text
chatcircle.empact.cn
```

没有显式 `tls { dns ... }` 配置。Caddy 使用 Automatic HTTPS 自动申请与续期证书，并负责 HTTP → HTTPS 跳转。因此：

- 80/443 必须从公网可达；
- 不再需要 `caddy-dns/alidns` 插件；
- 不再需要 Caddy 专用阿里云 DNS AccessKey；
- `caddy_data` 与 `caddy_config` 卷持久化 ACME 账户、证书和运行配置。

安全边界继续保持：

- `/_/*` 返回 403，生产不暴露 PocketBase 管理台；
- HSTS、CSP、nosniff、X-Frame-Options 等安全头由 Caddy 下发；
- Caddy 覆盖客户端传入的 `X-Forwarded-For`（app 与 public-web 两个上游都覆盖），后端来源 IP 以代理实际连接为准；
- 按路径分发：公开页 SSR → public-web:3100，功能 SPA 与 `/api/*` → app:8090；功能 SPA 路径带 `X-Robots-Tag: noindex`。完整路由表与维护口径见 `deploy/Caddyfile` 文件头注释；
- ⚠️ 线上服务器的 Caddy 若还有其他 vhost/import，部署时只替换本域名（chatcircle.empact.cn）的 site block。

## 5. 公开页渲染服务（public-web）

公开页（首页、关于、隐私、活动广场、活动详情、公开推文）由独立的 `public-web` 服务做服务端渲染（SSR），让搜索引擎与无 JS 抓取方直接读到正文、canonical/OG 元信息与 robots/sitemap；功能页（登录后的业务界面）仍是 PocketBase 同源伺服的 SPA。设计决策与否决方案见 [docs/planning/public-web-ssr-plan.md](../docs/planning/public-web-ssr-plan.md)，路由分界以 `deploy/Caddyfile` 文件头注释为准。

- 镜像：`deploy/public-web.Dockerfile`（两阶段构建，运行时只带 `dist-public/`，无 node_modules 依赖）；与 app/backup 一样按 `CC_RELEASE_SHA` 标记，`docker compose build` 统一构建。
- 职责：SSR HTML、`/public-assets/*`（hash 资源 immutable）、`/robots.txt`、`/sitemap.xml`、未知路径的真实 404。
- 配置（全部非密钥，compose 已显式给出生产口径）：`PORT`（3100）、`CC_SITE_ORIGIN`（canonical/OG/sitemap 的对外 origin，默认 `https://chatcircle.empact.cn`）、`CC_PB_INTERNAL_URL`（上游 PocketBase，私网 `http://app:8090`）；可选 `CC_PUBLIC_FETCH_TIMEOUT_MS`（单请求上游超时，默认 5000）、`CC_PUBLIC_MAX_INFLIGHT`（在飞上游请求上限，默认 32）。
- 健康检查：compose healthcheck 探 `/healthz`（浅活，不依赖上游）；`/readyz` 探上游 `/api/health`（2 秒超时），排障时用它区分「渲染服务挂」与「上游挂」。
- 故障影响面：public-web 崩溃或未就绪只让公开路由在 Caddy 侧 502/503，功能 SPA 与 `/api/*` 不受影响（caddy 不 depends_on public-web，公开渲染故障不会锁死原业务）。上游 PocketBase 故障时首页降级为 200（静态介绍仍在，列表区显示错误态），其余公开页 503 + `Retry-After: 30`，任何情况下不得挂死连接。
- 回滚：不单独发明机制——public-web 镜像与 Caddyfile 都随提交绑定，用 workflow_dispatch 重放上一个成功部署的 SHA 即整体回退。

## 6. 备份与恢复

每日备份由 Compose `backup` 服务中的前台 `crond` 执行镜像内的 `/etc/periodic/daily/backup`：

- `deploy/backup.Dockerfile` 在构建期安装 `tzdata` 与 `flock`，并以 `CC_RELEASE_SHA` 标记镜像；启动时不访问 apk 镜像源；
- 使用 PocketBase 备份 API 创建 SQLite + 上传文件一致性 ZIP；
- 下载到 `backups` 持久化卷；
- 默认滚动保留 `BACKUP_RETENTION_DAYS=30` 天；
- 结果写 `last_backup.json`；
- 尽力写入 `audit_logs` 的 `backup.success` / `backup.failed`，供超级管理后台告警。

手工触发：

```bash
docker compose exec backup sh /etc/periodic/daily/backup
docker compose exec backup cat /backups/last_backup.json
```

备份脚本使用备份卷中的 `.backup.lock` 阻塞锁，cron 和部署调用会排队，锁覆盖创建、下载、清理、结果标记及审计全过程；失败退出同样释放锁。不要删除锁文件，否则等待进程可能锁住不同 inode。归档文件名带随机后缀，避免同秒完成的两次调用覆盖文件；异地上传兼容新旧文件名。

**首次升级到构建期 runtime**：旧容器可能仍在启动时执行 `apk add`，更新 Git 不会改变它。部署会在切换生产提交前有限等待 backup runtime 就绪（PID 1 为 `crond`、脚本锁标记和 `flock` 存在），并在就绪后执行一次成功备份；任一条件失败都会停止。需要先更新 backup 服务：避开每日 02:00 窗口，用 `docker compose exec backup ps` 确认没有尚在运行的备份，等待其完成后，再用已审核版本的独立 checkout 仅替换 backup 服务。示例（项目名应与现有 Compose 项目一致）：

```sh
export CC_RELEASE_SHA="$(git -C /path/to/reviewed-checkout rev-parse HEAD)"
docker compose --project-name chatcircle \
  --env-file /opt/chatcircle/.env \
  -f /path/to/reviewed-checkout/docker-compose.yml \
  --project-directory /path/to/reviewed-checkout \
  build backup
docker compose --project-name chatcircle \
  --env-file /opt/chatcircle/.env \
  -f /path/to/reviewed-checkout/docker-compose.yml \
  --project-directory /path/to/reviewed-checkout \
  up --no-deps --no-build --pull never -d backup
```

只更新 backup 服务，不重建 app；确认 `docker compose ps` 显示 healthy，且 `/etc/periodic/daily/backup` 含 `# cc-backup-lock-v1`、`command -v flock` 成功，再重跑固定 SHA 的部署。在正式部署接管配置前保留该独立 checkout。此一次性操作不能在旧备份尚未结束时执行。

容器 `healthy` 只证明 runtime、脚本和 cron 进程可用，不证明最近一次备份成功；成功备份仍以 `/backups/last_backup.json` 的 `result=success`、归档 ZIP 校验和必要时的 `data.db`/`auxiliary.db` SQLite `quick_check` 为准。部署保留“成功备份后再切换 Git 提交”的门禁，部署后的 healthcheck 也只负责发现 runtime 退化。

恢复属于运维操作，执行前必须确认目标环境和备份文件，并事后补写恢复审计。最小流程：停止 app → 从最近一致备份恢复 `pb_data` → 启动 app → 校验账号、机构、活动、报名、签到、问卷与答卷。

异地 OSS 上传、加密、30 天生命周期、定时任务与恢复验收见 [异地备份手册](offsite-backup.md)。脚本需显式配置后启用，当前未验证真实异地副本。隐私政策、管理员 SMTP 与保留期限执行见 [隐私运营手册](../docs/privacy-operations.md)。

## 7. 常用排障

查看服务：

```bash
docker compose ps
```

查看 app：

```bash
docker compose logs --tail=120 app
```

查看 public-web（公开页 SSR；访问日志为 JSON 行，含 method/pathname/status/ms）：

```bash
docker compose logs --tail=120 public-web
docker compose exec public-web wget -qO- http://127.0.0.1:3100/readyz   # 区分渲染服务挂 vs 上游挂
```

查看 Caddy/证书：

```bash
docker compose logs --tail=150 caddy
```

验证 Compose 环境变量：

```bash
docker compose config -q
```

只确认短信 Secret 是否存在、不打印值：

```bash
for v in \
  CC_PHONE_HASH_KEY \
  ALIBABA_CLOUD_ACCESS_KEY_ID \
  ALIBABA_CLOUD_ACCESS_KEY_SECRET \
  CC_SMS_SIGN_NAME \
  CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE \
  CC_SMS_TEMPLATE_BIND_NEW_CODE \
  CC_SMS_TEMPLATE_VERIFY_BOUND_CODE; do
  if grep -q "^${v}=." .env; then echo "OK   $v"; else echo "MISS $v"; fi
done
```

不要把 `.env`、AccessKey Secret、手机号 HMAC key 或超管密码贴进 issue/PR/聊天截图。

## 8. 发布前人工门禁

自动化无法替代以下检查：

- DNS 指向正确生产 ECS；
- 安全组和主机防火墙开放 80/443；
- 80/443 无端口冲突；
- 服务器无 legacy `docker-compose.override.yml`；
- 真机短信登录/注册、绑定、换绑三类模板均成功；
- `https://chatcircle.empact.cn` 正常，无 `:8443`；
- `/api/health`、管理端、超级管理端和参与者端均正常；
- 公开页无 JS 可读：`curl -s https://chatcircle.empact.cn/ | grep -o 'rel="canonical"'` 与 `__CC_PUBLIC_DATA__` 均有命中，`curl -I https://chatcircle.empact.cn/login` 带 `X-Robots-Tag: noindex`（部署门禁已自动化前两项，此处人工复核）；
- 备份最近一次成功；
- 公安备案已于 2026-09-14 通过（沪公网安备31010402337130号，主域名 empact.cn），需在网站页脚补公安备案编号及查询链接（https://beian.mps.gov.cn/，属于合规展示，不影响当前 80/443 技术切换）。
