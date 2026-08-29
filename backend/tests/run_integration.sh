#!/usr/bin/env bash
# backend/tests/run_integration.sh — 后端集成测试套件一键入口（L3，test-plan §3/§8）
#
# 全程在临时数据目录自举真实 PocketBase 实例，不污染本地 pb_data：
#   1. 准备二进制（缺失则按平台自动下载 0.28.4，与 migration_smoke.sh 同逻辑）
#   2. 临时目录 migrate up（顺序应用全部迁移）
#   3. 创建测试超管（临时实例专用凭据，仅本次进程生命周期有效）
#   4. SQL 直插标准问卷模板首版（循环引用无法经 API 创建，见 integration/run.py 注释）
#   5. 显式 --dir/--migrationsDir/--hooksDir 启动 serve（不传会加载默认位置的错误内容）
#   6. 执行 integration/run.py 全部套件，输出逐条 PASS/FAIL 与汇总
#
# 用法：bash backend/tests/run_integration.sh
# 环境变量：
#   CC_IT_PORT  实例端口（默认 8097，避开本地开发 8090 与迁移冒烟 8099）
#   CC_IT_KEEP=1 保留临时目录（调试定位用，默认运行结束清理）
#   CC_IT_PAIRING_PAGE_SIZE  T2 队列分页测试页大小（默认 2，强制小 fixture 跨页）
# 退出码：全部断言通过为 0，任一失败为 1。
# 依赖：bash、curl、python3（标准库，无第三方包）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$BACKEND_DIR/pb_migrations"
HOOKS_DIR="$BACKEND_DIR/pb_hooks"
PB_VERSION="0.28.4"
PB="$BACKEND_DIR/pocketbase"
PORT="${CC_IT_PORT:-8097}"
BASE="http://127.0.0.1:$PORT"
PAIRING_PAGE_SIZE="${CC_IT_PAIRING_PAGE_SIZE:-2}"
SU_EMAIL="it-super@cc.local"
SU_PASS="cc_it_super_pass_123"

command -v python3 >/dev/null 2>&1 || { echo "缺少 python3（仅依赖标准库）"; exit 1; }

# --- 1. 准备 PocketBase 二进制 -------------------------------------------------
if [ ! -x "$PB" ]; then
  echo "[INFO] 未找到 backend/pocketbase，按 backend/README.md 下载 v$PB_VERSION"
  case "$(uname -s)_$(uname -m)" in
    Darwin_arm64)  PLAT="darwin_arm64" ;;
    Darwin_x86_64) PLAT="darwin_amd64" ;;
    Linux_x86_64)  PLAT="linux_amd64" ;;
    Linux_aarch64) PLAT="linux_arm64" ;;
    *) echo "不支持的平台：$(uname -s)_$(uname -m)，请手工下载 PocketBase $PB_VERSION 到 backend/"; exit 1 ;;
  esac
  TMP_ZIP="$(mktemp /tmp/pb_dl_XXXXXX.zip)"
  curl -fsSL -o "$TMP_ZIP" "https://github.com/pocketbase/pocketbase/releases/download/v$PB_VERSION/pocketbase_${PB_VERSION}_${PLAT}.zip"
  unzip -o -q "$TMP_ZIP" pocketbase -d "$BACKEND_DIR"
  rm -f "$TMP_ZIP"
fi

# --- 2. 临时数据目录 + 退出清理 ------------------------------------------------
WORK="$(mktemp -d /tmp/cc_it_XXXXXX)"
DATA_DIR="$WORK/pb_data"
SERVE_PID=""
cleanup() {
  if [ -n "$SERVE_PID" ] && kill -0 "$SERVE_PID" 2>/dev/null; then kill "$SERVE_PID" 2>/dev/null || true; fi
  if [ "${CC_IT_KEEP:-}" = "1" ]; then
    echo "[INFO] CC_IT_KEEP=1，保留临时目录：$WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# --- 3. 空库 migrate up ---------------------------------------------------------
# 注意：PocketBase 0.28 的 migrate 失败时也可能以退出码 0 结束（错误只打印），须同时查输出
"$PB" migrate up --dir "$DATA_DIR" --migrationsDir "$MIGRATIONS_DIR" --hooksDir "$HOOKS_DIR" \
  > "$WORK/migrate.log" 2>&1 || { cat "$WORK/migrate.log"; exit 1; }
if grep -q '^Error' "$WORK/migrate.log"; then cat "$WORK/migrate.log"; exit 1; fi
echo "[INFO] migrate up 完成（$(grep -cE '^Applied' "$WORK/migrate.log" || true) 个迁移）"

# --- 4. 测试超管 + 模板 SQL fixture ---------------------------------------------
"$PB" superuser create "$SU_EMAIL" "$SU_PASS" --dir "$DATA_DIR" > /dev/null 2>&1
python3 "$SCRIPT_DIR/integration/run.py" --sql-fixture --data-dir "$DATA_DIR"

# --- 5. 启动 serve（显式三目录参数） ----------------------------------------------
CC_PAIRING_PAGE_SIZE="$PAIRING_PAGE_SIZE" "$PB" serve \
  --dir "$DATA_DIR" --migrationsDir "$MIGRATIONS_DIR" --hooksDir "$HOOKS_DIR" \
  --http "127.0.0.1:$PORT" > "$WORK/serve.log" 2>&1 &
SERVE_PID=$!

READY=""
for _ in $(seq 1 40); do
  if curl -fsS "$BASE/api/cc/health" > /dev/null 2>&1; then READY=1; break; fi
  sleep 0.5
done
if [ -z "$READY" ]; then
  echo "[FAIL] serve 启动失败，日志如下："; tail -30 "$WORK/serve.log"; exit 1
fi
echo "[INFO] serve 就绪：${BASE}（hooks 健康检查 /api/cc/health 通过）"

# --- 6. 执行全部套件 --------------------------------------------------------------
python3 "$SCRIPT_DIR/integration/run.py" --base-url "$BASE" --su "$SU_EMAIL" --sp "$SU_PASS"
