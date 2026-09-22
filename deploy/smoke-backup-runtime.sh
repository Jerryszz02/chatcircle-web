#!/bin/sh
# Validate an already-built backup image without production volumes, credentials,
# or network access. The same smoke runs in CI and deployment preflight.
set -eu

IMAGE=${1:?usage: $0 IMAGE}
case "$IMAGE" in
  -*|'') echo "usage: $0 IMAGE" >&2; exit 2 ;;
esac

good_id=""
bad_id=""
cleanup() {
  [ -z "$good_id" ] || docker rm -f "$good_id" >/dev/null 2>&1 || true
  [ -z "$bad_id" ] || docker rm -f "$bad_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

wait_health() {
  name=$1
  expected=$2
  attempts=$3
  attempt=0
  while [ "$attempt" -lt "$attempts" ]; do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$name" 2>/dev/null || echo '')"
    [ "$status" = "$expected" ] && return 0
    attempt=$((attempt + 1))
    sleep 1
  done
  docker inspect "$name" || true
  return 1
}

good_id="$(docker run --detach --network none \
  --health-interval=1s --health-start-period=1s --health-retries=2 \
  "$IMAGE")"
wait_health "$good_id" healthy 30

# A broken script must fail the image healthcheck while crond itself remains up.
bad_id="$(docker run --detach --network none \
  --health-interval=1s --health-start-period=1s --health-retries=2 \
  "$IMAGE" sh -eu -c 'chmod -x /etc/periodic/daily/backup; exec crond -f -d 8')"
wait_health "$bad_id" unhealthy 30
test "$(docker inspect --format '{{.State.Running}}' "$bad_id")" = true
test "$(docker exec "$bad_id" cat /proc/1/comm)" = crond
