#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(dirname -- "$SCRIPT_DIR")"

cd "$REPO_ROOT"

echo '[T7] 发布配置与隐私不变量'
node deploy/verify-release-config.mjs
node --test deploy/verify-release-config.test.mjs
sh -n deploy/backup.sh

echo '[T7] PocketBase hooks 语法'
while IFS= read -r -d '' hook; do
  node --check "$hook"
done < <(find backend/pb_hooks -name '*.pb.js' -print0)

echo '[T7] 前端 lint / typecheck / unit / build'
npm run lint --prefix frontend
npm run typecheck --prefix frontend
npm run test --prefix frontend
npm run build --prefix frontend

echo '[T7] 生产依赖安全审计（production，moderate）'
npm audit --prefix frontend --omit=dev --audit-level=moderate
npm audit --prefix mcp --omit=dev --audit-level=moderate

echo '[T7] 迁移往返冒烟'
bash backend/tests/migration_smoke.sh

echo '[T7] 后端集成（权限 / 配对并发 / 实时口径 / 导出准确性）'
bash backend/tests/run_integration.sh

echo '[T7] 360px Chromium 全链路 E2E'
npm test --prefix e2e -- --project=chromium

git diff --check
echo '[T7] 自动化发布验收全部通过'
