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
- 每次结果写 `backups` 卷内 `last_backup.json` 标记（result/file/bytes/duration/reason/finished_at）。

手工触发一次：`docker compose exec backup sh /etc/periodic/daily/backup`，
然后查看标记：`docker compose exec backup cat /backups/last_backup.json`。

### 备份分工（与 super.pb.js 的关系）

| 入口 | 触发 | 结果去向 |
| --- | --- | --- |
| `deploy/backup.sh`（本目录） | 每日 cron 自动 | `backups/last_backup.json` 标记文件 |
| `POST /api/cc/super/backup/run`（产品端点） | 超管手动 / AC-23 演练（支持 force_fail 故障注入） | `audit_logs`（backup.success/failed），驱动 `/super` 后台 `backup-status` 告警 |

TODO(待后端配合)：每日备份结果接入 `audit_logs` 与 backup-status 告警需 hook 侧内部端点，
已回报主流程；接入前 AC-23 告警链路以 backup/run 演练为准，每日备份失败请巡检
`last_backup.json`（建议接入外部监控轮询该标记）。

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
  全站 HTTPS；app 的 8090 只绑 `127.0.0.1` 作本机调试入口。
- 反代选型 **Caddy**（镜像 `deploy/caddy.Dockerfile` 编译进 `caddy-dns/alidns` 插件），
  配置 `deploy/Caddyfile`，站点 `chatcircle.empact.cn`。
- **未备案期间的特殊处置（2026-08 首次部署）**：境内 ECS（上海）80/443 被阿里云拦截，
  故 ① 对外端口临时用 **8443**（访问 `https://chatcircle.empact.cn:8443`，安全组放行 8443）；
  ② 证书签发改走 **DNS-01 挑战**（HTTP-01/TLS-ALPN-01 依赖 80/443，不可用），凭据为
  仅授 `AliyunDNSFullAccess` 的 RAM AccessKey，经 `.env` 的
  `ALIYUN_ACCESS_KEY_ID/SECRET` 注入。
- **备案完成后的切换步骤**：Caddyfile 站点地址去掉 `:8443` → compose 端口映射改
  `443:443`（可加 `80:80` 让 Caddy 自动跳 HTTPS）→ 安全组放行 80/443 →
  `docker compose up -d` 重建 caddy；证书会自动按新地址重签，无需其他改动。

## 6. 验证记录（如实声明）

- `deploy/backup.sh`：本机以真实 PocketBase 0.28.4 实例进程级验证成功路径
  （建备份→下载→PK 校验→删服务端副本→写标记）与失败路径（错误凭据→failure 标记）；
  本机无 wget/Docker，wget 语义以 curl shim 模拟，**busybox wget 真实兼容性未验证**。
- `docker-compose.yml`：通过 YAML 语法与结构自查（depends_on/healthcheck/环境插值）；
  **未经 `docker compose config` 与真实构建验证**。
- 定时触发（crond 每日）未验证：已验证的仅为脚本本体，cron 接线沿用既有占位实现。
