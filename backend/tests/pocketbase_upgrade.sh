#!/usr/bin/env bash
# Verify that the patched PocketBase migrates a synthetic database created by
# the old release without touching backend/pb_data or backend/pocketbase.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$BACKEND_DIR/pb_migrations"
HOOKS_DIR="$BACKEND_DIR/pb_hooks"
EXPECTED_VERSION="${PB_VERSION:-0.39.7}"
PB="${CC_PB_BINARY:-${PB_BINARY:-$BACKEND_DIR/pocketbase}}"
LOG_DIR="${CC_UPGRADE_LOG_DIR:-/tmp/chatcircle-upgrade-logs}"
WORK="$(mktemp -d /tmp/cc_pb_upgrade.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

if [ ! -x "$PB" ]; then
  echo "PocketBase binary not found or not executable: $PB" >&2
  echo "Set CC_PB_BINARY to a verified release binary outside the repository." >&2
  exit 2
fi
mkdir -p "$LOG_DIR"

version="$($PB --version | head -n 1)"
case "$version" in
  *"$EXPECTED_VERSION"*) ;;
  *) echo "Expected PocketBase $EXPECTED_VERSION, got: $version" >&2; exit 1 ;;
esac

OLD_VERSION="${PB_OLD_VERSION:-0.28.4}"
OLD_SHA256="${PB_OLD_SHA256:-}"
OLD_BINARY="${CC_PB_OLD_BINARY:-$WORK/pocketbase-old}"
if [ ! -x "$OLD_BINARY" ]; then
  case "$(uname -s)_$(uname -m)" in
    Darwin_arm64) PLAT=darwin_arm64 ;;
    Darwin_x86_64) PLAT=darwin_amd64 ;;
    Linux_x86_64) PLAT=linux_amd64 ;;
    Linux_aarch64) PLAT=linux_arm64 ;;
    *) echo "Unsupported platform for old PocketBase fixture" >&2; exit 2 ;;
  esac
  archive="$WORK/pocketbase-old.zip"
  if [ -z "$OLD_SHA256" ]; then
    echo "PB_OLD_SHA256 is required when downloading the old fixture binary." >&2
    exit 2
  fi
  curl -fsSL -o "$archive" "https://github.com/pocketbase/pocketbase/releases/download/v$OLD_VERSION/pocketbase_${OLD_VERSION}_${PLAT}.zip"
  if command -v sha256sum >/dev/null 2>&1; then
    echo "$OLD_SHA256  $archive" | sha256sum -c -
  else
    echo "$OLD_SHA256  $archive" | shasum -a 256 -c -
  fi
  unzip -q "$archive" pocketbase -d "$WORK"
  mv "$WORK/pocketbase" "$OLD_BINARY"
fi

# Recreate the audited application schema, including real historical migrations.
# Migration files are immutable; the cutoff is the audited be0c73d schema.
mkdir "$WORK/old_migrations" "$WORK/old_hooks" "$WORK/pb_data"
for migration in "$MIGRATIONS_DIR"/*.js; do
  name="$(basename "$migration")"
  if [ "${name%%_*}" -le 1788600000 ]; then cp "$migration" "$WORK/old_migrations/"; fi
done
"$OLD_BINARY" migrate up --dir "$WORK/pb_data" --migrationsDir "$WORK/old_migrations" --hooksDir "$WORK/old_hooks" >"$WORK/old-migrate.log" 2>&1
if grep -q '^Error' "$WORK/old-migrate.log"; then cat "$WORK/old-migrate.log"; exit 1; fi
"$OLD_BINARY" superuser create upgrade@example.test synthetic-upgrade-password --dir "$WORK/pb_data" >/dev/null
python3 - "$WORK/pb_data/data.db" <<'PYFIXTURE'
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("INSERT INTO organizations (id,name,status) VALUES ('upgradeorg00001','Old fixture retained','active')")
PYFIXTURE
# A stopped consistent old-version copy is retained for rollback validation.
cp -R "$WORK/pb_data" "$WORK/old_restore"
log="$WORK/migrate.log"
set +e
"$PB" migrate up --dir "$WORK/pb_data" --migrationsDir "$MIGRATIONS_DIR" --hooksDir "$HOOKS_DIR" >"$log" 2>&1
code=$?
set -e
if [ "$code" -ne 0 ] || grep -q '^Error' "$log"; then
  echo "PocketBase $EXPECTED_VERSION migration failed (exit=$code):" >&2
  cat "$log" >&2
  exit 1
fi
python3 "$SCRIPT_DIR/pocketbase_upgrade_verify.py" "$PB" "$OLD_BINARY" "$WORK" "$HOOKS_DIR" "$MIGRATIONS_DIR" >>"$log" 2>&1 || {
  cat "$log"; cp "$log" "$LOG_DIR/upgrade-failed.log"; exit 1;
}
persisted_log="$LOG_DIR/pocketbase-upgrade-$(date +%Y%m%d%H%M%S).log"
cp "$log" "$persisted_log"

echo "PocketBase $OLD_VERSION -> $EXPECTED_VERSION synthetic database migration completed."
echo "Migration log: $persisted_log"
