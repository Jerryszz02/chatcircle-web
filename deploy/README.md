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
CC_BACKUP_KEY=<至少32字符的随机专用备份密钥>
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

已有生产数据卷且超级管理员已经存在时不要重复创建；这一步只用于首次初始化。该账号仅用于超级管理与受控运维；backup 使用独立 CC_BACKUP_KEY，不持有超管凭据。

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
- 同一网关上的其他站点配置存放在 `caddy_config` 持久卷中的 `/config/sites/*.caddy`，由仓库 Caddyfile 的顶层 `import` 加载。空目录无需额外配置。不要再直接向 `deploy/Caddyfile` 追加其他站点，以免阻塞 Git 快进。
- 迁移已有追加配置时，先独立备份完整 Caddyfile 与 Git diff，确认改动仅为其他站点的完整 block，再将这些 block 原样存入 `/config/sites/`。先使用候选 Caddyfile 执行 `caddy validate`，确认成功后才恢复仓库文件并部署；未知修改或校验失败必须保留原配置并停止。
- 可通过 `docker compose cp <已审核的站点配置> caddy:/config/sites/<站点>.caddy` 维护站点文件（目录须先创建），校验后使用既有 `caddy reload` 流程生效。不要在这些文件里重复定义 `chatcircle.empact.cn`。
- `/config/sites/` 不包含在 PocketBase 每日数据备份中，修改前须单独备份到服务器受保护目录；不得用 `docker compose down -v` 删除网关配置和证书卷。回滚到不支持此 import 的旧版本前，须先恢复完整网关配置，不能直接套用旧的单站点 Caddyfile。

## 5. 公开页渲染服务（public-web）

公开页（首页、关于、隐私、活动广场、活动详情、公开推文）由独立的 `public-web` 服务做服务端渲染（SSR），让搜索引擎与无 JS 抓取方直接读到正文、canonical/OG 元信息与 robots/sitemap；功能页（登录后的业务界面）仍是 PocketBase 同源伺服的 SPA。设计决策与否决方案见 [docs/planning/public-web-ssr-plan.md](../docs/planning/public-web-ssr-plan.md)，路由分界以 `deploy/Caddyfile` 文件头注释为准。

- 镜像：`deploy/public-web.Dockerfile`（两阶段构建，运行时只带 `dist-public/`，无 node_modules 依赖）；与 app/backup 一样按 `CC_RELEASE_SHA` 标记，`docker compose build` 统一构建。
- 职责：SSR HTML、`/public-assets/*`（hash 资源 immutable）、`/robots.txt`、`/sitemap.xml`、未知路径的真实 404。
- 配置（全部非密钥，compose 已显式给出生产口径）：`PORT`（3100）、`CC_SITE_ORIGIN`（canonical/OG/sitemap 的对外 origin，默认 `https://chatcircle.empact.cn`）、`CC_PB_INTERNAL_URL`（上游 PocketBase，私网 `http://app:8090`）；可选 `CC_PUBLIC_FETCH_TIMEOUT_MS`（单请求上游超时，默认 5000）、`CC_PUBLIC_MAX_INFLIGHT`（在飞上游请求上限，默认 32）。
- 健康检查：compose healthcheck 探 `/healthz`（浅活，不依赖上游）；`/readyz` 探上游 `/api/health`（2 秒超时），排障时用它区分「渲染服务挂」与「上游挂」。
- 故障影响面：public-web 崩溃或未就绪只让公开路由在 Caddy 侧 502/503，功能 SPA 与 `/api/*` 不受影响（caddy 不 depends_on public-web，公开渲染故障不会锁死原业务）。上游 PocketBase 故障时首页降级为 200（静态介绍仍在，列表区显示错误态），其余公开页 503 + `Retry-After: 30`，任何情况下不得挂死连接。
- 回滚：不单独发明机制——public-web 镜像与 Caddyfile 都随提交绑定，用 workflow_dispatch 重放上一个成功部署的 SHA 即整体回退。

## 6. 备份与恢复

每日备份由非 root `backup-scheduler.py` 在 Asia/Shanghai 02:00 执行 `/etc/periodic/daily/backup`。手工与定时任务共用 `.backup.lock`，不要删除锁文件。

- app 通过内部专用接口调用 PocketBase 一致性备份，流式下载后删除本次服务端副本；不接受调用者传入文件路径，也不提供恢复接口。
- backup 仅挂载 backups 卷，只有 `CC_BACKUP_KEY`，不能使用原生超管 API；网关拒绝 `/api/cc/internal/*`。
- 下载后验证 ZIP CRC、data.db 和 auxiliary.db 的 SQLite quick_check，原子落盘；默认保留最新 `BACKUP_RETENTION_COUNT=2` 份，保持已合并 PR #79 的策略；按纳秒修改时间排序，先验证所有保留点再清理。每份归档附带版本/SHA-256 元数据，最近结果写 last_backup.json，并通过受限接口写固定备份审计。
- runtime healthy 只证明调度器心跳；`check-backup.py` 独立检查失败、36 小时未更新、归档缺失/大小变化；宿主机监控也能发现 backup 容器停止。

```bash
docker compose exec -T backup sh /etc/periodic/daily/backup
docker compose exec -T backup python3 /usr/local/bin/check-backup.py
```

**升级顺序**：先在受控 `.env` 中预置至少 32 字符的随机 `CC_BACKUP_KEY`，候选镜像验证通过后，使用旧服务生成成功备份，再运行 `prepare-runtime-volumes.sh` 将 app/backups/Caddy 的确切命名卷调整为 UID/GID 10001。旧 root 进程仍可读写；最后切换整个 Compose，app 和 backup 必须同时升级。部署流水线会执行卷迁移和新服务的首次实际备份。不再支持把新版 backup 单独连接到没有专用接口的旧 app。

四个服务均非 root、只读根目录、no-new-privileges、cap_drop ALL；仅 Caddy 保留 NET_BIND_SERVICE。app 512 MiB/128 PIDs，其他服务各 192 MiB（backup 32、公开页和网关64 PIDs），合计运行内存上限1088 MiB；宿主机/Empact/构建另计。四条内部网络按业务连接拆分；app 单独出口，Caddy 保留现有 default 网桥，以保持 Empact 到宿主机的代理地址。Docker 网络不能替代接口鉴权。

真实恢复与邮件告警的操作、前置配置和验收边界见 [备份恢复与告警手册](backup-recovery.md)。恢复必须针对明确目标、匹配代码版本与 HMAC key；禁止直接用生产数据卷做演练。可复用的隔离演练命令（镜像已构建）：

```bash
python3 deploy/rehearse-restore.py --tag <候选镜像标签> --destination /var/lib/chatcircle-rehearsal/<全新目录>
```

该命令只复制当前成功归档，使用独立目录/内部网络，不开放宿主机端口，不配置短信/邮件凭据。默认在成功或失败退出时删除本次隔离容器和网络，保留受控恢复目录。需要继续邮件演练时显式加 `--keep-running`，结束后按报告中的唯一 project 执行 `down`（不加 `-v`）。恢复目录包含业务数据和环境密钥，必须受控保存。

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
