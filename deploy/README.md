# Chat Circles 生产部署手册（M5）

> 当前生产基线：`chatcircle.empact.cn` 已完成 ICP 备案，正式入口使用标准 TCP 80/443。
> Caddy 负责 Automatic HTTPS 与反向代理；未备案时期的 `:8443 + DNS-01 + ALIYUN_ACCESS_KEY_*` 已退出正式架构。

## 1. 部署拓扑

```text
浏览器
  │ HTTP 80 / HTTPS 443
  ▼
Caddy（Automatic HTTPS、HTTP→HTTPS、反向代理）
  │ Docker 私网
  ▼
PocketBase app:8090（前端静态资源 + API + hooks）
  │
  ├─ pb_data 持久化卷
  └─ backup 服务每日一致性备份 → backups 卷
```

生产基础 Compose **不向宿主机发布 PocketBase 8090**；只有 Caddy/backup 通过 Docker 私网访问 `app:8090`。需要本机调试时才显式叠加 `deploy/docker-compose.debug.yml`。

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
4. 预拉取 Caddy/backup 运行时镜像；
5. 构建候选镜像；
6. 检查 `CC_PHONE_HASH_KEY >= 32` 和 production+aliyun 短信必填变量；
7. 全部通过后才 fast-forward `/opt/chatcircle/main`；
8. `docker compose up --build -d`；
9. 轮询 app 容器 healthcheck，90 秒内必须进入 `healthy`。

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
- Caddy 覆盖客户端传入的 `X-Forwarded-For`，后端来源 IP 以代理实际连接为准。

## 5. 备份与恢复

每日备份由 Compose `backup` 服务中的 cron 执行 `deploy/backup.sh`：

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

恢复属于运维操作，执行前必须确认目标环境和备份文件，并事后补写恢复审计。最小流程：停止 app → 从最近一致备份恢复 `pb_data` → 启动 app → 校验账号、机构、活动、报名、签到、问卷与答卷。

生产备份仍需后续补充加密和异地同步。

## 6. 常用排障

查看服务：

```bash
docker compose ps
```

查看 app：

```bash
docker compose logs --tail=120 app
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

## 7. 发布前人工门禁

自动化无法替代以下检查：

- DNS 指向正确生产 ECS；
- 安全组和主机防火墙开放 80/443；
- 80/443 无端口冲突；
- 服务器无 legacy `docker-compose.override.yml`；
- 真机短信登录/注册、绑定、换绑三类模板均成功；
- `https://chatcircle.empact.cn` 正常，无 `:8443`；
- `/api/health`、管理端、超级管理端和参与者端均正常；
- 备份最近一次成功；
- 公安备案审核通过后按要求在网站页脚补公安备案信息（属于合规展示，不影响当前 80/443 技术切换）。
