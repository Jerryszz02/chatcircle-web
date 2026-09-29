#!/bin/sh
# Only synthetic named volumes in a unique Compose project; no production mounts.
set -eu
IMAGE=${1:?usage: $0 IMAGE}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORK=$(mktemp -d /tmp/cc-permissions.XXXXXX)
PROJECT=cc-permissions-$(basename "$WORK" | tr '[:upper:].' '[:lower:]-')
export CC_PERMISSION_TEST_IMAGE="$IMAGE"
export COMPOSE_PROJECT_NAME="$PROJECT"
cleanup() {
  (cd "$WORK" && docker compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -f "$WORK/compose.yml"
  rmdir "$WORK" || true
}
trap cleanup EXIT INT TERM
cat > "$WORK/compose.yml" <<'YAML'
services:
  app:
    image: ${CC_PERMISSION_TEST_IMAGE}
    user: "0"
    command: [sleep, '600']
    volumes: [data:/pb/pb_data]
  backup:
    image: ${CC_PERMISSION_TEST_IMAGE}
    user: "0"
    command: [sleep, '600']
    volumes: [backups:/backups]
  caddy:
    image: ${CC_PERMISSION_TEST_IMAGE}
    user: "0"
    command: [sleep, '600']
    volumes: [certs:/data, config:/config]
volumes:
  data: {}
  backups: {}
  certs: {}
  config: {}
YAML
cd "$WORK"
docker compose up -d >/dev/null
for spec in app:/pb/pb_data backup:/backups caddy:/data caddy:/config; do
  docker compose exec -T "${spec%%:*}" sh -eu -c 'touch "$1/root-owned"; chown 0:0 "$1/root-owned"; chmod 600 "$1/root-owned"' sh "${spec#*:}"
done
sh "$SCRIPT_DIR/prepare-runtime-volumes.sh" "$IMAGE"
for spec in app:/pb/pb_data backup:/backups caddy:/data caddy:/config; do
  docker compose exec -T --user 10001:10001 "${spec%%:*}" sh -eu -c 'test "$(stat -c %u "$1/root-owned")" = 10001; cat "$1/root-owned"; touch "$1/nonroot-write"' sh "${spec#*:}"
done
echo 'RUNTIME_VOLUME_PERMISSIONS_OK'
