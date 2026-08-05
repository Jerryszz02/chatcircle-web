#!/bin/sh
# Chat Circles 每日备份脚本（technical-design §5.8 落地实现，由 compose backup service 的 crond 每日触发）。
#
# 一致性方案：PocketBase 自带备份 API（POST /api/backups，内部走 SQLite 在线备份，
# 对 WAL 活跃库可生成一致快照；ZIP 内含 data.db 与上传文件），替代旧的 tar 直打包
# （tar 复制活跃 SQLite 文件不保证一致性）。
#
# 流程：健康等待 → 超管登录（凭据仅经环境变量注入，不写日志不落库）→ 创建备份
#       → 下载到 backups 卷 → 校验 ZIP → 删除服务端副本 → 滚动清理 30 天 → 写结果标记。
#
# 结果标记：写 $BACKUP_DEST/last_backup.json（result/file/bytes/duration/reason）。
# 与 super.pb.js 的分工（详见 deploy/README.md「备份分工」）：
#   - 本脚本：每日自动一致性快照，结果写标记文件；
#   - POST /api/cc/super/backup/run：手动演练入口，结果写审计（backup.success/failed），
#     GET /api/cc/super/backup-status 据此驱动超管后台告警（AC-23）。
#   - TODO(待后端配合)：每日备份结果接入 audit_logs 需 hook 侧提供内部写入端点，
#     属后端改动，已回报主流程；接入前 AC-23 告警以 backup/run 演练链路为准。
set -eu

PB_URL=${PB_URL:-http://app:8090}
DEST=${BACKUP_DEST:-/backups}
PBDATA=${BACKUP_PBDATA:-/pbdata}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}
: "${PB_SUPERUSER_EMAIL:?须以环境变量注入超管邮箱（部署期 secrets，见 .env.example）}"
: "${PB_SUPERUSER_PASSWORD:?须以环境变量注入超管密码}"

mkdir -p "$DEST"
TS=$(date +%Y%m%d_%H%M%S)
NAME="cc_daily_${TS}.zip"
MARKER="$DEST/last_backup.json"
STARTED=$(date +%s)

# 结果标记：供运维巡检与外部告警轮询读取（JSON 单行，字段与审计 metadata 对齐）
write_marker() {
    # $1=result(success/failure) $2=file $3=bytes $4=reason
    NOW_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    printf '{"result":"%s","file":"%s","bytes":%s,"duration_ms":%s,"reason":"%s","finished_at":"%s"}\n' \
        "$1" "$2" "$3" "$(( ($(date +%s) - STARTED) * 1000 ))" "$4" "$NOW_ISO" > "$MARKER"
}

fail() {
    echo "[backup] FAILED: $1" >&2
    write_marker failure "" 0 "$1"
    exit 1
}

# 1. 等待 PocketBase 就绪（容器同启时 app 可能尚未起来）
i=0
until wget -qO- "$PB_URL/api/health" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -ge 30 ] && fail "等待 $PB_URL 就绪超时"
    sleep 2
done

# 2. 超管登录取 token（不打印 token；busybox 环境无 jq，用 sed 提取）
AUTH_JSON=$(wget -qO- \
    --post-data "{\"identity\":\"$PB_SUPERUSER_EMAIL\",\"password\":\"$PB_SUPERUSER_PASSWORD\"}" \
    --header 'Content-Type: application/json' \
    "$PB_URL/api/collections/_superusers/auth-with-password") || fail "超管登录请求失败"
TOKEN=$(printf '%s' "$AUTH_JSON" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || fail "超管登录未返回 token（凭据错误？）"

# 3. 创建备份（服务端落盘 pb_data/backups/<name>）
wget -qO- \
    --post-data "{\"name\":\"$NAME\"}" \
    --header "Authorization: $TOKEN" \
    --header 'Content-Type: application/json' \
    "$PB_URL/api/backups" >/dev/null || fail "POST /api/backups 失败"

# 4. 下载到 backups 卷（与 pb_data 卷分离，异地同步目标待确认，见 §5.8）。
#    注意（0.28.4 实测）：备份下载走受保护文件模式，超管 token 直接 GET 返回 403，
#    须先 POST /api/files/token 换一次性文件 token，再以 ?token= 下载。
FILE_TOKEN=$(wget -qO- \
    --post-data '' \
    --header "Authorization: $TOKEN" \
    "$PB_URL/api/files/token" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$FILE_TOKEN" ] || fail "获取文件下载 token 失败"
wget -qO "$DEST/$NAME" \
    "$PB_URL/api/backups/$NAME?token=$FILE_TOKEN" || fail "下载备份文件失败"

# 5. 校验：非空且为 ZIP（PK 头）
[ -s "$DEST/$NAME" ] || fail "备份文件为空"
[ "$(head -c 2 "$DEST/$NAME")" = "PK" ] || fail "备份文件非 ZIP 格式"
BYTES=$(wc -c < "$DEST/$NAME" | tr -d ' ')

# 6. 删除服务端副本（pb_data 卷不积累每日归档，备份卷才是归档归属；
#    PocketBase 会为每个备份生成同名 .attrs 元数据边车文件，一并清理）
rm -f "$PBDATA/backups/$NAME" "$PBDATA/backups/$NAME.attrs" \
    || echo "[backup] warn: 未能删除服务端副本 $PBDATA/backups/$NAME" >&2

# 7. 滚动清理：删除超过保留天数的归档
find "$DEST" -name 'cc_daily_*.zip' -type f -mtime "+${RETENTION_DAYS}" -delete

write_marker success "$NAME" "$BYTES" ""
echo "[backup] written: $DEST/$NAME (${BYTES} bytes, retention: ${RETENTION_DAYS} days)"
