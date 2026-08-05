#!/usr/bin/env bash
# backend/scripts/seed_demo.sh — 本地开发库演示种子数据一键注入
#
# 注入内容（幂等，可重复执行）：
#   - 演示机构 ×2：阿尔法（发布审核关、敏感导出开）/ 贝塔（发布审核开、敏感导出关）
#   - 标准报名字段（nickname 必填 / phone 敏感 / age / channel）
#   - 标准问卷模板首版（见下方「为什么用 SQL 直插」）
#   - 每机构一名演示管理员（经邀请码流程创建）+ 每机构一枚未使用邀请码（打印明文，
#     供体验 /admin/register 邀请码注册链路）
#   - 机构阿尔法下演示活动（已发布）+ 活动问卷（已开放）
#   - 演示参与者 ×2（demo_speaker / demo_listener）+ 报名并审核通过
#
# 为什么用 SQL 直插模板：survey_templates.current_version_id ↔
# survey_template_versions.template_id 构成循环引用，无法经集合 API 一次创建
# （迁移 1785888660 顶部注释；PocketBase 也没有绕过校验的导入接口）。
# 模板首版是平台级初始化数据（technical-design §5.7「迁移执行与模板初始化」），
# 故用 sqlite3 直插，列名与该迁移建表结构一致。除模板外其余数据全部走 API 注入。
#
# 用法：
#   bash backend/scripts/seed_demo.sh
# 环境变量（均有默认值）：
#   PB_DATA_DIR     数据目录（默认 backend/pb_data）
#   SEED_PORT       注入时临时实例端口（默认 8096；注入完成后实例即停止）
#   SEED_SU_EMAIL   本地演示超管邮箱（默认 admin@cc.local，仅本地开发用）
#   SEED_SU_PASS    本地演示超管密码（默认 cc_demo_pass_123，仅本地开发用）
#
# 注意：脚本会自带一个临时 serve 完成 API 注入后停止；若已有 pocketbase serve
# 占用同一数据目录，请先停止再运行（避免两个实例写同一 SQLite）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PB="$BACKEND_DIR/pocketbase"
PB_VERSION="0.28.4"
DATA_DIR="${PB_DATA_DIR:-$BACKEND_DIR/pb_data}"
PORT="${SEED_PORT:-8096}"
BASE="http://127.0.0.1:${PORT}"
SU_EMAIL="${SEED_SU_EMAIL:-admin@cc.local}"
SU_PASS="${SEED_SU_PASS:-cc_demo_pass_123}"

command -v python3 >/dev/null 2>&1 || { echo "缺少 python3（仅依赖标准库）"; exit 1; }

if [ ! -x "$PB" ]; then
  echo "[FAIL] 未找到 backend/pocketbase，请先按 backend/README.md 下载 v${PB_VERSION} 二进制"
  exit 1
fi

# 同目录实例冲突检查：避免两个 PocketBase 进程写同一 SQLite
if pgrep -f "pocketbase serve" >/dev/null 2>&1 && pgrep -f "pocketbase serve.*${DATA_DIR}" >/dev/null 2>&1; then
  echo "[FAIL] 检测到使用 ${DATA_DIR} 的 pocketbase serve 正在运行，请先停止再注入种子"
  exit 1
fi

echo "[INFO] 数据目录：${DATA_DIR}"
mkdir -p "$DATA_DIR"

# 1. 迁移（幂等；显式三目录参数，不传会加载默认位置的错误内容）
"$PB" migrate up --dir "$DATA_DIR" \
  --migrationsDir "$BACKEND_DIR/pb_migrations" --hooksDir "$BACKEND_DIR/pb_hooks"

# 2. 本地演示超管（已存在则跳过；凭据仅用于本地开发，打印在末尾汇总中）
"$PB" superuser create "$SU_EMAIL" "$SU_PASS" --dir "$DATA_DIR" >/dev/null 2>&1 \
  && echo "[INFO] 已创建演示超管 ${SU_EMAIL}" || echo "[INFO] 演示超管 ${SU_EMAIL} 已存在，跳过创建"

# 3. 标准问卷模板首版 SQL 直插（原因见文件头注释）
python3 "$SCRIPT_DIR/seed_demo.py" --sql-fixture --data-dir "$DATA_DIR"

# 4. 临时 serve + API 注入
SERVE_PID=""
cleanup() {
  if [ -n "$SERVE_PID" ] && kill -0 "$SERVE_PID" 2>/dev/null; then
    kill "$SERVE_PID" 2>/dev/null || true
    wait "$SERVE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

"$PB" serve --dir "$DATA_DIR" \
  --migrationsDir "$BACKEND_DIR/pb_migrations" --hooksDir "$BACKEND_DIR/pb_hooks" \
  --http "127.0.0.1:${PORT}" > /tmp/cc_seed_serve.log 2>&1 &
SERVE_PID=$!

READY=""
for _ in $(seq 1 40); do
  if curl -fsS "${BASE}/api/cc/health" > /dev/null 2>&1; then READY=1; break; fi
  sleep 0.5
done
if [ -z "$READY" ]; then
  echo "[FAIL] 临时 serve 启动失败，日志：/tmp/cc_seed_serve.log"; exit 1
fi

python3 "$SCRIPT_DIR/seed_demo.py" --base-url "$BASE" --su "$SU_EMAIL" --sp "$SU_PASS"

echo
echo "[INFO] 种子注入完成，临时实例已停止。按 backend/README.md 启动开发服务器即可使用上述演示数据。"
