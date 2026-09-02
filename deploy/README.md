# Chat Circles 生产部署手册（M5）

> 依据：technical-design §5.7/§5.8、security-privacy §11、PRD §12。
> 状态：备份脚本与 compose 已经本机进程级验证（见「验证记录」）；
> **Docker 镜像构建与 compose 起停未在本机验证**（开发机无 Docker），首次在有
> Docker 的环境执行时请以本文为清单逐步核对。

## 1. 部署拓扑

一体化镜像（Dockerfile 多阶段）：前端 build 产物放 `pb_public/` 由 PocketBase **同源伺服**，
反向代理只做 TLS 与域名路由（technical-design §5.7）。两个命名卷：

| 卷 | 内容 | 说明 |
| --- | --- | --- |
| `pb_data` | SQLite（data.db/auxiliary.db）+ 上传文件 | 镜像与数据分离；升级只换镜像不动卷 |
| `backups` | 每日备份归档 `cc_daily_*.zip` + `last_backup.json` 标记 | 滚动保留 30 天；异地同步目标待确认 |

## 2. 首次部署步骤

```bash
cp .env.example .env
# 编辑 .env：必填 PB_SUPERUSER_EMAIL / PB_SUPERUSER_PASSWORD（backup 服务注入用，secrets 不入库）

docker compose up --build -d

# 创建生产超级管理员（一次性；凭据即 .env 中注入的那一对，二者需一致，
# 否则 backup 服务登录失败、备份标记为 failure）
docker compose exec app ./pocketbase superuser create "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" --dir /pb/pb_data
```

冒烟清单（AC-01）：参与者端 `/`、机构管理端 `/admin/login`、超级管理端 `/super/login`、
`/api/health` 均正常；创建一个测试机构走通邀请码注册。

升级：`docker compose up --build -d`（镜像重建，`pb_data`/`backups` 卷不受影响；
迁移由 PocketBase 启动时自动应用 `pb_migrations`）。

## 3. 备份

每日自动备份由 compose `backup` 服务的 crond 触发 `deploy/backup.sh`：

- 调 PocketBase 备份 API（`POST /api/backups`，内部为 SQLite 在线备份，对 WAL 活跃库一致），
  ZIP 含 data.db、auxiliary.db 与上传文件；
- 超管凭据经 `PB_SUPERUSER_EMAIL/PASSWORD` 环境变量注入（0.28.4 实测：下载需先
  `POST /api/files/token` 换文件 token，脚本已处理）；
- 归档下载到 `backups` 卷后删除 `pb_data/backups` 内的服务端副本（含 `.attrs` 边车）；
- 滚动清理 30 天前归档（`BACKUP_RETENTION_DAYS` 可调）；
- 每次结果写 `backups` 卷内 `last_backup.json` 标记（result/file/bytes/duration/reason/finished_at）；
- 同时写 `audit_logs`（actor=system，action=`backup.success`/`backup.failed`），驱动
  `/super` 后台 backup-status 告警（AC-23）；审计写入为尽力而为，失败不影响备份结果，
  登录失败等拿不到超管 token 的早期失败无法写审计，以 `last_backup.json` 标记为准。

手工触发一次：`docker compose exec backup sh /etc/periodic/daily/backup`，
然后查看标记：`docker compose exec backup cat /backups/last_backup.json`。

### 备份分工（与 super.pb.js 的关系）

| 入口 | 触发 | 结果去向 |
| --- | --- | --- |
| `deploy/backup.sh`（本目录） | 每日 cron 自动 | `backups/last_backup.json` 标记文件 + `audit_logs`（backup.success/failed），驱动 `/super` 后台 `backup-status` 告警 |
| `POST /api/cc/super/backup/run`（产品端点） | 已下线（410 Gone，2026-08 安全加固） | 不再写审计；手动演练改用 `docker compose exec backup sh /etc/periodic/daily/backup` |

备份结果写 `audit_logs` 复用脚本已有的超管 token 直插集合 API（createRule 对超管放行，
口径与 `tests/integration/suite_backup.py` 的播种一致），无需新增 hook 端点。
早期失败（健康等待超时、超管登录失败等拿不到 token 的场景）无法写审计，
请巡检 `last_backup.json`（建议接入外部监控轮询该标记）。

## 4. 恢复演练（AC-19，M5 冻结前在测试环境实测签字）

恢复是运维操作，V1 无产品化一键恢复；执行前须二次确认并事后补写恢复审计（§5.8）。

```bash
# 0) 二次确认：目标环境、备份文件、当前数据将被覆盖
# 1) 停机
docker compose stop app
# 2) 取最近备份并解压到临时目录
docker compose run --rm --no-deps -v chatcircleweb_backups:/b alpine:3.20 \
  sh -c 'mkdir /tmp/r && cd /tmp/r && unzip -o /b/$(ls -t /b | grep "^cc_daily_.*\.zip$" | head -1)'
#   （卷名以 docker volume ls 实际为准；也可先 docker cp 出来再操作）
# 3) 用解压出的 data.db / auxiliary.db（及 storage/ 如有）覆盖 pb_data 卷后启动
docker compose start app
# 4) 校验：/api/health 正常；机构、活动、账号、报名、签到、问卷、答卷抽查可找回
# 5) 记录演练结果（AC-19 验收依据），并按 §5.8 补写恢复审计
```

备选路径：把备份 ZIP 放到 `pb_data/backups/` 后用 PocketBase 自带恢复
（`POST /api/backups/{key}/restore`，超管鉴权，恢复后需重启进程）。

## 5. HTTPS 与反向代理

- 生产禁止明文 HTTP（PRD §11.2）：compose `caddy` 服务终止 TLS，转发到 app:8090，
  全站 HTTPS；**生产默认不向 host 发布 app 的 8090**（2026-09 安全加固，见 §5「安全加固」），
  仅经 Docker 私网供 Caddy/backup 访问。需要本机直连调试或经 SSH 隧道让 MCP 访问后端时，
  显式附加 `docker compose -f docker-compose.yml -f docker-compose.debug.yml up -d`（`deploy/docker-compose.debug.yml`，
  含「本地伪造 XFF」风险警示，仅限知悉下使用）。
- 反代选型 **Caddy**（镜像 `deploy/caddy.Dockerfile` 编译进 `caddy-dns/alidns` 插件），
  配置 `deploy/Caddyfile`，站点 `chatcircle.empact.cn`。
- **未备案期间的特殊处置（2026-08 首次部署）**：境内 ECS（上海）80/443 被阿里云拦截，
  故 ① 对外端口临时用 **8443**（访问 `https://chatcircle.empact.cn:8443`，安全组放行 8443）；
  ② 证书签发改走 **DNS-01 挑战**（HTTP-01/TLS-ALPN-01 依赖 80/443，不可用），凭据为
  RAM AccessKey（当前为 `AliyunDNSFullAccess`，过宽，待按下文「运维行动项清单」②
  收窄为单 hosted zone 最小权限），经 `.env` 的
  `ALIYUN_ACCESS_KEY_ID/SECRET` 注入。
- **备案完成后的切换步骤**：Caddyfile 站点地址去掉 `:8443` → compose 端口映射改
  `443:443`（可加 `80:80` 让 Caddy 自动跳 HTTPS）→ 安全组放行 80/443 →
  `docker compose up -d` 重建 caddy；证书会自动按新地址重签，无需其他改动。

### 安全响应头与 PB 管理台封闭（2026-08 安全加固）

- Caddyfile 统一下发安全响应头：`Strict-Transport-Security`（max-age=31536000;
  includeSubDomains）、`X-Content-Type-Options: nosniff`、`Referrer-Policy:
  strict-origin-when-cross-origin`、`Content-Security-Policy: default-src 'self';
  img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`
  （`style-src 'unsafe-inline'` 为 React 内联样式所需），另加 `X-Frame-Options: DENY`
  兼容不支持 frame-ancestors 的旧浏览器。
- **PB 管理台（`/_/`）生产封闭**：`handle /_/* { respond 403 }`。日常运营不需要暴露
  PocketBase dashboard（统一走产品内 `/super` 后台）；临时排障时注释 Caddyfile 中该
  `handle /_/*` 段并 `docker compose restart caddy`，用完立即恢复封闭。
- **X-Forwarded-For 覆盖**：`reverse_proxy` 显式 `header_up X-Forwarded-For
  {remote_host}`，客户端伪造的 XFF 不会进入后端——访问日志与审计中的来源 IP 可信，
  这也是后续在 Caddy/应用层做按 IP 限流的前提（伪造 XFF 会绕过或误伤限流）。

### 运维行动项清单（安全加固后续）

1. **删除服务器上的 `docker-compose.override.yml`**：过渡期明文 HTTP 8443 配置
   （见「自动部署」节）已不需要，保留会让明文入口继续暴露；删除后
   `docker compose up -d` 重建确认无残留端口映射。
2. **RAM 权限收窄**：caddy DNS-01 用的 AccessKey 由 `AliyunDNSFullAccess` 改为
   自定义策略，仅放行 chatcircle.empact.cn 所在 hosted zone 的
   `DescribeDomains`/`AddDomainRecord`/`DeleteDomainRecord`/`DescribeDomainRecords`
   （见 `.env.example` 注释）。
3. **备份加密与异地同步（§5.8 待落地）**：backups 卷目前为本地明文留存，需确定
   加密方案与异地同步目标存储、凭据下发方式。

## 6. 自动部署（GitHub Actions）

`.github/workflows/deploy.yml`：push / 合并到 `main` 后，runner 经 SSH 登录 ECS，
在 `/opt/chatcircle` 执行 `git fetch && git merge --ff-only origin/main &&
docker compose up --build -d`——即 §2 手动升级命令的自动化，无需人工上服务器。
也可在 Actions 页面手动触发（workflow_dispatch）。

- 所需 Secrets：`ECS_SSH_PRIVATE_KEY`（部署专用密钥对，公钥在服务器
  `authorized_keys`，comment `github-actions-deploy-chatcircle`）、`ECS_HOST`、`ECS_USER`。
- 服务器仓库有本地 `docker-compose.override.yml`（过渡期明文 HTTP 8443，不入库），
  checkout/pull 不会触碰；`concurrency` 串行化部署，避免并发重建。
  **该 override 待删除**，见 §5「运维行动项清单」①。

## 7. 验证记录（如实声明）

- `deploy/backup.sh`：本机以真实 PocketBase 0.28.4 实例进程级验证成功路径
  （建备份→下载→PK 校验→删服务端副本→写标记）与失败路径（错误凭据→failure 标记）；
  本机无 wget/Docker，wget 语义以 curl shim 模拟，**busybox wget 真实兼容性未验证**。
- 2026-08 安全加固改动（trap 兜底标记、保留天数校验、`--post-file` 登录、失败路径
  清理服务端副本、原子写标记）：`sh -n` 语法检查通过；本机以 wget shim 进程级冒烟
  5 场景 18 断言全过（成功路径含 `"`/`\` 凭据的 JSON 转义往返、非法保留天数、
  登录失败、下载失败服务端副本清理、模拟 set -e 中断的 trap 兜底标记）；
  仍**未经 busybox/容器内真实环境验证**。
- 2026-08 审计接入改动（record_audit 写 audit_logs）：`sh -n` 语法检查通过；
  本机以真实 PocketBase 0.28.4 实例进程级验证（wget 语义以 curl shim 模拟）：
  成功路径（建备份→下载→PK 校验→写标记→写 backup.success 审计→
  backup-status 返回 alert=false 且含文件名/时间）与失败路径（失败→failure 标记
  + backup.failed 审计含 reason）均实测通过；**busybox wget 真实兼容性仍未验证**。
- `docker-compose.yml`：通过 YAML 语法与结构自查（depends_on/healthcheck/环境插值）；
  安全加固新增项（三服务 logging、backup TZ + tzdata 安装）经 YAML 解析与结构断言；
  **未经 `docker compose config` 与真实构建验证**（本机无 Docker）。
- `deploy/Caddyfile`：安全头 / `/_/` 封闭 / XFF 覆盖为人工语法核对，**本机无 caddy，
  未经 `caddy validate`**；首次部署时请先 `docker compose exec caddy caddy validate
  --config /etc/caddy/Caddyfile`。
- `Dockerfile`：PB_SHA256 取自官方 release `checksums.txt` 并经本机下载真实 zip 实测
  比对一致，`sha256sum -c` 校验命令形式本机实测可用；**镜像未真实构建**（本机无 Docker）。
- 定时触发（crond 每日）未验证：已验证的仅为脚本本体，cron 接线沿用既有占位实现。
