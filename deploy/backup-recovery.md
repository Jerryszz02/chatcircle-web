# 备份权限、恢复与邮件告警

## 发布前准备

本改动涉及已有数据卷的 UID/GID 和共享网关网络；不得只上线新 backup。

1. 在服务器受控 `.env` 预置随机 `CC_BACKUP_KEY`（至少32字符），app/backup 使用同一值；不再将 PB_SUPERUSER_* 注入备份容器。原超管账号仍供人员登录，暂不删除或改密码。
2. 保存当前发布 SHA、Compose、`.env`、Caddy `/config/sites` 与 `/data` 的受控副本；手机号 HMAC key 必须保留且与数据库匹配。数据库 ZIP 不包括这些外部配置。
3. 候选构建/恢复演练通过后，由部署流水线先用旧运行时备份，再调整实际命名卷所有者为10001，再切换 app/backup/public-web/caddy。helper 不接收任意宿主目录；`smoke-runtime-permissions.sh` 验证 root 私有文件迁移后非 root 可读写。
4. Caddy 仍连既有 default 网桥，保护 Empact 的 `172.18.0.1` 上游。切换后同时验证 `chatcircle.empact.cn` 和 `empact.cn`。回滚须使用原匹配代码/镜像/配置；原 root 镜像可以访问10001所有的卷，不应随意反向递归改权限。
5. 部署后实际生成一次新备份，检查 marker、版本/SHA侧车、后台状态与邮件监控；不能仅看容器 healthy。

## 邮件配置清单

宿主机监控 `backup-monitor.py` 从独立的 `/etc/chatcircle/backup-alert.env` 读取以下变量。文件目录700、文件600、root所有，不进 Git。可从已有官网配置受控复制这几个字段，不能把整个官网环境注入备份容器。

| 项目 | 变量 | 作用 |
|---|---|---|
| 邮件服务器 | SMTP_HOST / SMTP_PORT | 供应商提供的 SMTP 主机、465 或587等端口 |
| 传输加密 | SMTP_SECURE | true 为隐式 TLS；false 必须升级 STARTTLS，证书验证始终开启 |
| 发信身份 | SMTP_USER / SMTP_PASS | 邮箱账号与 SMTP 授权码/应用密码；不用网页登录密码替代供应商要求 |
| 发件地址 | BACKUP_ALERT_FROM 或 CONTACT_FROM | 必须是该账号获准使用的地址 |
| 收件地址 | BACKUP_ALERT_TO 或 CONTACT_TO | 故障负责人邮箱；需确认能收到故障和恢复两封测试邮件 |

服务器已有官网 SMTP_HOST/PORT/SECURE/USER/PASS、CONTACT_FROM/TO，本次邮件演练直接在服务器内读取，没有下载或输出凭据。仍需正式保存独立配置并启用定时监控。邮箱供应商若要求 IP 白名单或发信授权，应允许当前 ECS；使用自有发信域名时按供应商要求配置 SPF/DKIM/DMARC。更换授权码后更新受控文件，再执行监控演练；不要在聊天或 PR 中贴密码。

安装（仅在新 backup 已运行且 `check-backup.py` 通过后）：

```sh
install -d -m 700 /var/lib/chatcircle-monitor
install -m 644 deploy/chatcircle-backup-monitor.service deploy/chatcircle-backup-monitor.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now chatcircle-backup-monitor.timer
systemctl start chatcircle-backup-monitor.service
systemctl status chatcircle-backup-monitor.timer --no-pager
```

每15分钟检查一次。失败立刻发信，持续同类失败24小时提醒一次，恢复再发一封。SMTP失败不会推进已通知状态，下次重试；邮件错误仅写类型，避免服务器响应泄露凭据。宿主机本身停止时本机任务无法发信，整机故障仍需独立外部监控；本轮未新增第三方服务。

## 隔离恢复方法与验收

`rehearse-restore.py` 只接受一个尚不存在的目标目录；复制正在运行备份容器 marker 指向的成功归档，校验大小、ZIP、SQLite，再启动候选版本。无生产数据挂载，无宿主机端口，无外部网络，无短信/邮件凭据。HMAC key 在服务器内注入隔离后端；超管测试凭据仅经 stdin 传递，不写进命令行。报告不包含业务行。

生产恢复还应明确备份对应代码版本、秘密配置、快照之后的数据处理和停机窗口；本脚本是演练工具，不对生产做覆盖恢复。备份本身包含敏感业务与认证材料，目标目录必须受控且不可发布到网站/CI artifact。演练结束，按报告的唯一 project 执行 `docker compose -p <project> -f <目标>/docker-compose.yml down`，不加 `-v`；受控归档按保留策略处理。

检查：所有服务健康；首页/about/activities/login/super/login/API 返回成功；超管可登录，匿名不能读备份状态；隔离实例可再次生成和验证备份；停止隔离 app 后对照业务表数量与上传哈希。允许审计和限流计数表因探测增加。恢复版本会应用新迁移时，应先使用匹配版本核对快照，再独立验收升级。

PocketBase 内部快照使用官方 [createBackup](https://pocketbase.io/jsvm/functions/_app.createBackup.html) 与 [backup filesystem](https://pocketbase.io/jsvm/interfaces/filesystem.System.html)；HTTP请求 context 在0.39.7真实集成测试中验证，不再使用直接复制活动SQLite文件的旧方案。

## 2026-09-29 隔离验收记录

此记录是本次证据，不代表生产已部署。

- 生产基线：`d7b685bcb373af4976f316ba597f1d4406f771b1`。正式容器未替换；仅通过现有脚本生成新的一致性备份。
- 成功归档：`cc_daily_20260929_135526_9127927039cda5ba.zip`；SHA-256 `ecb1372b81d95a531b7f73eca9a8d0d24a78a243f578283a7fad9ee4e8e2fb41`。
- 隔离 project `cc-restore-5b713569`，报告位于 ECS 受控目录 `/var/lib/chatcircle-rehearsal/security-20260929/run3/report.json`。
- ZIP与两库 quick_check通过；28张业务表（不含审计、限流计数的增量比较）数量一致，2个上传文件哈希一致。公开页、功能SPA、API、超管登录/匿名拒绝、恢复后再备份通过。
- 四个容器实际UID10001、只读根目录、cap_drop ALL、内存/PIDs上限生效；backup仅一条internal网络，无法解析public-web。
- 在隔离实例注入非法保留配置，使真实备份任务失败并写失败标记/审计；宿主机监控发送故障测试信。正常重跑备份后发送恢复信。两次SMTP均接受，**收件箱实际送达尚未确认**。
- 早期旧归档配当前代码时触发问卷模板迁移，数量比较未通过；已改用与当前生产版本对应的新快照重新验证，未覆盖旧归档或生产数据。
- 仓库验证：747项后端断言、34项Node部署/后端测试、15项Python测试、41项发布配置检查通过；规划链接审计通过。真实容器 smoke 和 root→非 root 命名卷权限迁移 smoke 通过。
- 尚未验收：生产切换后的双站点复核、正式邮件timer运行、独立外部整机监控、真实OSS异地副本恢复。
