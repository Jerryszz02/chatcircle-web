#!/bin/sh
# Consistent backup via a scoped internal endpoint; no superuser or pb_data access.
set -eu
umask 077
DEST=${BACKUP_DEST:-/backups}
mkdir -p "$DEST"
# cc-backup-lock-v1
# Share the same inode with cron/deploy/manual calls, including result writes.
exec 9>"$DEST/.backup.lock"
flock -x 9
exec python3 "$(dirname "$0")/backup-worker.py"
