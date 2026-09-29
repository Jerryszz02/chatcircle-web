#!/bin/sh
# Run from the production checkout AFTER a verified old-runtime backup.
# Existing root processes can still access these volumes. Never change host paths.
set -eu
IMAGE=${1:?usage: prepare-runtime-volumes.sh CANDIDATE_BACKUP_IMAGE}
for spec in app:/pb/pb_data backup:/backups caddy:/data caddy:/config; do
  service=${spec%%:*}
  destination=${spec#*:}
  cid=$(docker compose ps -q "$service")
  [ -n "$cid" ] || { echo "Missing running service: $service" >&2; exit 1; }
  volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "'"$destination"'"}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}{{end}}' "$cid")
  [ -n "$volume" ] || { echo "Expected named volume: $spec" >&2; exit 1; }
  # Only this service's exact named volume is mounted; no network or Docker socket.
  docker run --rm --network none --user 0 --read-only \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --security-opt no-new-privileges --mount "type=volume,src=$volume,dst=/target" \
    --entrypoint sh "$IMAGE" -eu -c 'chown -R -h 10001:10001 /target'
done
