#!/bin/sh
# Chat Circles 每日备份脚本（technical-design §5.8 落地实现，由 compose backup service 的 crond 每日触发）。
#
# 一致性方案：PocketBase 自带备份 API（POST /api/backups，内部走 SQLite 在线备份，
# 对 WAL 活跃库可生成一致快照；ZIP 内含 data.db 与上传文件），替代旧的 tar 直打包
# （tar 复制活跃 SQLite 文件不保证一致性）。
#
# 流程：健康等待 → 超管登录（凭据仅经环境变量注入；请求体走 600 权限临时文件
#       --post-file，密码不进进程列表）→ 创建备份 → 下载到 backups 卷 → 校验 ZIP
#       → 删除服务端副本（成功/失败路径都删）→ 滚动清理 30 天 → 原子写结果标记。
#
# 结果标记：写 $BACKUP_DEST/last_backup.json（result/file/bytes/duration/reason），
# 先写临时文件再 mv 原子替换；脚本任何非零退出（fail 或 set -e 意外中断）都会
# 留下 failure 标记，避免外部监控读到陈旧的成功标记。
# 与 super.pb.js 的分工（详见 deploy/README.md「备份分工」）：
#   - 本脚本：每日自动一致性快照，结果写标记文件（backups/last_backup.json），
#     同时写入 audit_logs（见下）；
#   - GET /api/cc/super/backup-status：超管后台告警读取（聚合 backup.* 审计，AC-23）。
#   - POST /api/cc/super/backup/run 已下线（410 Gone，2026-08 安全加固）：原 JSVM
#     库文件复制并非一致性快照（假备份），不再写 backup.success/failed 审计，
#     手动演练一律改用本脚本（见 docs/security-hardening-2026-08.md §3）。
#
# 审计接入（方案 A，2026-08）：备份结果经 record_audit() 写入 audit_logs
# （actor=system，action=backup.success/backup.failed，口径与
# tests/integration/suite_backup.py 的播种一致），驱动超管后台 backup-status 告警。
# 实现上复用脚本已有的超管 token 直插集合 API（audit_logs createRule 对超管放行，
# 无需新增 hook 端点）。审计写入为尽力而为：失败仅打 warn、不影响备份结果与标记；
# 超管登录失败等拿不到 token 的早期失败无法写审计，此场景以 last_backup.json 为准。
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
# 结果标记是否已写：fail() 写过后 trap 兜底不再覆盖
MARKER_WRITTEN=0
# 本次调用是否已在服务端建好备份副本（POST /api/backups 成功后置 1）：
# 并发/同秒重跑会产生同名备份，失败清理必须只删本次调用自己创建的副本，
# 否则会删掉另一调用刚建好的 ZIP，导致其下载失败、两边都没有备份
SERVER_COPY_CREATED=0
# 超管登录请求体临时文件路径（--post-file 用），trap 兜底清理
AUTH_BODY=""
# 超管 token（审计写入用）；登录成功前为空，fail() 据此判断是否可写审计
TOKEN=""

# JSON 字符串转义（busybox 无 jq）：转义会破坏 JSON 结构的反斜杠与双引号
json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# 销毁敏感临时文件：优先 shred 覆写，无 shred 时退化为 rm
secure_rm() {
    shred -u "$1" 2>/dev/null || rm -f "$1"
}

# 结果标记：供运维巡检与外部告警轮询读取（JSON 单行，字段与审计 metadata 对齐）。
# 先写同目录临时文件再 mv 原子替换，避免轮询方读到半截 JSON；字段值经 JSON 转义
write_marker() {
    # $1=result(success/failure) $2=file $3=bytes $4=reason
    NOW_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    TMP_MARKER=$(mktemp "$DEST/.last_backup.XXXXXX")
    printf '{"result":"%s","file":"%s","bytes":%s,"duration_ms":%s,"reason":"%s","finished_at":"%s"}\n' \
        "$1" "$(json_escape "$2")" "$3" "$(( ($(date +%s) - STARTED) * 1000 ))" "$(json_escape "$4")" "$NOW_ISO" \
        > "$TMP_MARKER"
    mv "$TMP_MARKER" "$MARKER"
    MARKER_WRITTEN=1
}

# 备份结果写 audit_logs（方案 A）：驱动超管后台 backup-status 告警（AC-23）。
# 复用超管 token 直插集合 API（createRule 对超管放行）；尽力而为，调用方须容忍失败。
# $1=result(success/failure) $2=file $3=bytes $4=reason
record_audit() {
    [ -n "$TOKEN" ] || return 0
    if [ "$1" = "success" ]; then ACTION="backup.success"; else ACTION="backup.failed"; fi
    DURATION_MS=$(( ($(date +%s) - STARTED) * 1000 ))
    FINISHED_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    wget -qO- \
        --post-data "{\"actor_id\":\"system\",\"actor_role\":\"system\",\"organization_id\":\"\",\"action\":\"$ACTION\",\"target_type\":\"backup\",\"target_id\":\"daily\",\"result\":\"$1\",\"reason\":\"$(json_escape "$4")\",\"metadata\":{\"file\":\"$(json_escape "$2")\",\"bytes\":$3,\"duration_ms\":$DURATION_MS,\"finished_at\":\"$FINISHED_ISO\"}}" \
        --header "Authorization: $TOKEN" \
        --header 'Content-Type: application/json' \
        "$PB_URL/api/collections/audit_logs/records" >/dev/null
}

# 删除服务端 pb_data/backups 副本（pb_data 卷不积累每日归档，备份卷才是归档归属；
# PocketBase 会为每个备份生成同名 .attrs 元数据边车文件，一并清理）。
# 成功/失败路径都要调用：备份在「服务端已建副本、尚未下载」阶段失败时（如取文件
# token 失败）也会残留副本，反复失败会在 pb_data 卷累积，故统一收进 fail()。
# 仅当本次调用实际创建了服务端副本（SERVER_COPY_CREATED=1）才删除：
# 同名并发场景下不清理他人副本（见 SERVER_COPY_CREATED 注释）。
cleanup_server_copy() {
    [ "$SERVER_COPY_CREATED" -eq 1 ] || return 0
    rm -f "$PBDATA/backups/$NAME" "$PBDATA/backups/$NAME.attrs" \
        || echo "[backup] warn: 未能删除服务端副本 $PBDATA/backups/$NAME" >&2
}

fail() {
    echo "[backup] FAILED: $1" >&2
    cleanup_server_copy
    write_marker failure "" 0 "$1"
    record_audit failure "" 0 "$1" || echo "[backup] warn: 备份失败审计写入失败" >&2
    exit 1
}

# 兜底：未走 fail() 的非零退出（set -e 中断、命令意外失败）也写 failure 标记；
# fail() 已写标记时（MARKER_WRITTEN=1）不重复覆盖
on_exit() {
    rc=$?
    if [ "$rc" -ne 0 ] && [ "$MARKER_WRITTEN" -eq 0 ]; then
        write_marker failure "" 0 "脚本异常退出（exit=$rc）" || true
        record_audit failure "" 0 "脚本异常退出（exit=$rc）" \
            || echo "[backup] warn: 备份失败审计写入失败" >&2
    fi
    [ -z "$AUTH_BODY" ] || secure_rm "$AUTH_BODY"
}
trap on_exit EXIT

# 入口校验：保留天数必须为纯数字（供 find -mtime 使用，非法值直接失败）
case "$RETENTION_DAYS" in
    ''|*[!0-9]*) fail "BACKUP_RETENTION_DAYS 非法（须为非负整数）：$RETENTION_DAYS" ;;
esac

# 1. 等待 PocketBase 就绪（容器同启时 app 可能尚未起来）
i=0
until wget -qO- "$PB_URL/api/health" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -ge 30 ] && fail "等待 $PB_URL 就绪超时"
    sleep 2
done

# 2. 超管登录取 token（不打印 token；busybox 环境无 jq，用 sed 提取）。
#    请求体写入 600 权限临时文件走 --post-file：--post-data 会把密码暴露在进程列表；
#    邮箱/密码中的双引号与反斜杠先 JSON 转义，用完即销毁
AUTH_BODY=$(mktemp)
chmod 600 "$AUTH_BODY"
printf '{"identity":"%s","password":"%s"}' \
    "$(json_escape "$PB_SUPERUSER_EMAIL")" \
    "$(json_escape "$PB_SUPERUSER_PASSWORD")" > "$AUTH_BODY"
if ! AUTH_JSON=$(wget -qO- \
    --post-file "$AUTH_BODY" \
    --header 'Content-Type: application/json' \
    "$PB_URL/api/collections/_superusers/auth-with-password"); then
    secure_rm "$AUTH_BODY"; AUTH_BODY=""
    fail "超管登录请求失败"
fi
secure_rm "$AUTH_BODY"; AUTH_BODY=""
TOKEN=$(printf '%s' "$AUTH_JSON" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || fail "超管登录未返回 token（凭据错误？）"

# 3. 创建备份（服务端落盘 pb_data/backups/<name>）
wget -qO- \
    --post-data "{\"name\":\"$NAME\"}" \
    --header "Authorization: $TOKEN" \
    --header 'Content-Type: application/json' \
    "$PB_URL/api/backups" >/dev/null || fail "POST /api/backups 失败"
SERVER_COPY_CREATED=1

# 4. 下载到 backups 卷（与 pb_data 卷分离，异地同步目标待确认，见 §5.8）。
#    注意（0.28.4 实测）：备份下载走受保护文件模式，超管 token 直接 GET 返回 403，
#    须先 POST /api/files/token 换一次性文件 token，再以 ?token= 下载。
FILE_TOKEN=$(wget -qO- \
    --post-data '' \
    --header "Authorization: $TOKEN" \
    "$PB_URL/api/files/token" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$FILE_TOKEN" ] || fail "获取文件下载 token 失败"

if ! wget -qO "$DEST/$NAME" \
    "$PB_URL/api/backups/$NAME?token=$FILE_TOKEN"; then
    rm -f "$DEST/$NAME"  # 清掉可能的半截下载文件，避免被误当有效归档
    fail "下载备份文件失败"
fi

# 5. 校验：非空且为 ZIP（PK 头）
[ -s "$DEST/$NAME" ] || fail "备份文件为空"
[ "$(head -c 2 "$DEST/$NAME")" = "PK" ] || fail "备份文件非 ZIP 格式"
BYTES=$(wc -c < "$DEST/$NAME" | tr -d ' ')

# 6. 删除服务端副本
cleanup_server_copy

# 7. 滚动清理：删除超过保留天数的归档
find "$DEST" -name 'cc_daily_*.zip' -type f -mtime "+${RETENTION_DAYS}" -delete

write_marker success "$NAME" "$BYTES" ""
record_audit success "$NAME" "$BYTES" "" || echo "[backup] warn: 备份成功审计写入失败" >&2
echo "[backup] written: $DEST/$NAME (${BYTES} bytes, retention: ${RETENTION_DAYS} days)"
