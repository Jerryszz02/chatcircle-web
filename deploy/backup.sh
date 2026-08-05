#!/bin/sh
# Chat Circles 每日备份脚本（M0 占位实现，见 technical-design §5.8）
# 打包 pb_data 到 /backups，滚动清理超过保留天数的归档。
# TODO(M5)：SQLite 在线一致性备份 + 结果写 audit_logs（action=backup）+ 异地同步。
set -eu

SRC=${BACKUP_SRC:-/data}
DEST=${BACKUP_DEST:-/backups}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}

mkdir -p "$DEST"
TS=$(date +%Y%m%d_%H%M%S)
FILE="$DEST/pb_data_${TS}.tar.gz"

tar -czf "$FILE" -C "$SRC" .
echo "[backup] written: $FILE ($(du -h "$FILE" | cut -f1))"

# 滚动清理：删除超过保留天数的归档
find "$DEST" -name 'pb_data_*.tar.gz' -type f -mtime "+${RETENTION_DAYS}" -delete
echo "[backup] cleanup done (retention: ${RETENTION_DAYS} days)"
