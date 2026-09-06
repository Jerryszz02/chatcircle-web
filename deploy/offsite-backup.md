# 服务器自动异地备份

本机 Docker `backups` 卷可以应对误操作，但服务器或磁盘损坏时仍可能一起丢失。已有 backup 服务每日北京时间 02:00 左右调用 PocketBase 在线备份 API，取得数据库与上传文件的一致 ZIP。本手册在它之后增加异地副本；不复制正在运行的 SQLite 文件。

状态：脚本与无云服务单元测试已提供，**OSS 桶、凭据、服务器定时任务、真实上传/恢复均尚未配置或验收**。只有真实下载恢复成功，才能勾选发布清单的备份门禁。

## 一次性准备

1. 在与 ECS **不同的中国大陆地域**创建专用私有 OSS 桶。例如 ECS 在上海，备份可放北京或深圳。不要选择境外地域。开通会产生存储、请求及跨地域公网流量费用，先在账户内确认预算。
2. 开启阻止公共访问、服务端默认加密（SSE-OSS 或经批准的 SSE-KMS）、HTTPS。配置专用 `chatcircle/daily/` 前缀的生命周期：30 天到期清理；若开启版本控制，还需清理非当前版本、删除标记及未完成分片，避免旧个人数据无限保留。检查控制台实际规则并保存验收证据。生命周期执行可能有服务延迟，隐私请求需按运营手册单独处理。
3. 使用独立备份 RAM 身份，权限只限上述桶/前缀的上传、分片上传必要操作和读取校验；不给删对象、改 ACL、改生命周期或其他业务桶权限。优先使用 ECS RAM Role 的短期凭据。短信 RAM 身份不得复用。恢复人员使用独立受控账号。ECS/本机备份所在磁盘同时配置加密和访问限制。
4. 服务器安装 Python 3 与官方 ossutil 2，Docker Compose 已由现有部署提供。交互执行 `ossutil config -c /root/.ossutil-chatcircle`，按控制台输入地域、HTTPS endpoint 与凭据，然后 `chmod 600 /root/.ossutil-chatcircle`。不把密钥放命令参数、Git、本文或聊天中。

## 首次执行与定时

先在服务器项目目录执行已有的一致备份：

```bash
cd /opt/chatcircle
docker compose exec -T backup sh /etc/periodic/daily/backup
docker compose exec -T backup cat /backups/last_backup.json
```

确认本机备份成功后，将命令中的 `YOUR_PRIVATE_BUCKET` 换成刚建的真实桶名：

```bash
python3 /opt/chatcircle/deploy/offsite-backup.py \
  --project /opt/chatcircle \
  --destination oss://YOUR_PRIVATE_BUCKET/chatcircle/daily/ \
  --config /root/.ossutil-chatcircle \
  --marker /var/lib/chatcircle-offsite/last_backup.json
```

脚本只接受最近 26 小时内成功的本机备份，核对文件名、字节数和 ZIP 完整性；随后上传，再下载同一对象并比对 SHA-256。下载校验成功才写 `result=success`；失败退出非零并更新失败标记，不会用旧成功覆盖失败。临时下载文件退出时清理。该步骤包含真实云上传/下载，会产生流量费用；不在部署 workflow 中自动执行。

首次成功后在服务器 `sudo crontab -e` 中增加一行（先用 `timedatectl` 确认服务器时区为 Asia/Shanghai；已有定时项保持原样）：

```cron
30 3 * * * /usr/bin/python3 /opt/chatcircle/deploy/offsite-backup.py --project /opt/chatcircle --destination oss://YOUR_PRIVATE_BUCKET/chatcircle/daily/ --config /root/.ossutil-chatcircle --marker /var/lib/chatcircle-offsite/last_backup.json >> /var/log/chatcircle-offsite.log 2>&1
```

确认 cron 的 PATH 能找到 `docker` 和 `ossutil`，日志设置轮转和受限权限。脚本需要读取项目 Compose/.env，但不打印其值。首次定时执行后查看标记并在 OSS 控制台核对对象；不能把“配置了 cron”视作“已有异地备份”。

## 监控与恢复验收

- 本机层：现有 `last_backup.json` 与后台 `backup.success/failed` 告警。
- 异地层：监控 `/var/lib/chatcircle-offsite/last_backup.json`，文件不存在、失败、成功时间超过 26 小时均告警。该标记尚未接入网站超管告警，需服务器监控接入；若服务器整体掉线，外部监控也应告警。不要只监控本机备份成功。
- 每月至少用一个异地 ZIP 在**隔离环境**恢复并抽查账号、活动、报名、签到、配对、问卷、上传与导出权限。脚本的 SHA-256 一致证明传输完整，不代替应用恢复演练。
- `CC_PHONE_HASH_KEY`、其他恢复所需密钥与配置另存于受控密码库，不随普通 ZIP 公布。手机号 HMAC 密钥丢失会影响账号查找；恢复前确认密钥对应备份版本。
- 隐私请求台账独立受控保存，恢复后先落实快照之后的更正/删除/注销，再开放服务。详见 [隐私运营手册](../docs/privacy-operations.md)。

官方依据：[ossutil 定时上传](https://help.aliyun.com/zh/oss/developer-reference/configure-scheduled-synchronization-tasks)、[ossutil 配置](https://help.aliyun.com/en/oss/developer-reference/configure-ossutil)、[OSS 加密](https://help.aliyun.com/zh/oss/developer-reference/bucket-encryption)。按每个地域的实际控制台与账单核对费用和可用功能。
