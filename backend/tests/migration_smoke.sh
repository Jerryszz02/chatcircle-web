#!/usr/bin/env bash
# backend/tests/migration_smoke.sh — pb_migrations 迁移冒烟验证（M0）
#
# 验证内容（test-plan §8「迁移校验」job 的本地版）：
#   1. 空库 migrate up 成功；
#   2. migrate down 全部回滚 → 再次 migrate up，往返成功；
#   3. serve 启动后经 API 抽查：
#      - 25 个业务集合全部存在（字段/规则随集合定义）；
#      - 未认证访问业务集合被拒或为空（无公开广场，FR-ACT-002）；
#      - 活动公开详情经 /api/cc/public/activities 白名单端点可达，原生 viewRule 仅本机构
#        管理员（匿名/参与者 404，FR-ACT-003 收敛后形态）；
#      - 复合唯一索引生效（registrations 参与者×活动，FR-REG-003）；
#      - 参与者/管理员/超管三类身份的隔离规则生效（database-design §5.4）；
#      - 业务集合 delete 关闭（无硬删除，FR-AUD-001）。
#
# 用法：bash backend/tests/migration_smoke.sh
# 依赖：curl、python3；PocketBase 二进制不存在时按 backend/README.md 自动下载（darwin_arm64/linux_amd64）。
# 全程使用临时数据目录，不污染仓库与本地 pb_data。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$BACKEND_DIR/pb_migrations"
HOOKS_DIR="$BACKEND_DIR/pb_hooks"
PB_VERSION="0.28.4"
PB="$BACKEND_DIR/pocketbase"
PORT="${CC_SMOKE_PORT:-8099}"
BASE="http://127.0.0.1:$PORT"

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); echo "[PASS] $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "[FAIL] $1"; }
info() { echo "[INFO] $1"; }

# check <描述> <实际值> <期望值（字符串相等）>
check_eq() {
  local desc="$1" actual="$2" expect="$3"
  if [ "$actual" = "$expect" ]; then ok "$desc"; else bad "${desc}（期望=${expect}，实际=${actual}）"; fi
}

# json_val <python 表达式，输入 stdin JSON 记为 d>
json_val() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null || echo ""; }

# --- 0. 准备 PocketBase 二进制 -------------------------------------------------
if [ ! -x "$PB" ]; then
  info "未找到 backend/pocketbase，按 backend/README.md 下载 v$PB_VERSION"
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

# --- 1. 临时数据目录 + 退出清理 ------------------------------------------------
WORK="$(mktemp -d /tmp/cc_mig_smoke_XXXXXX)"
DATA_DIR="$WORK/pb_data"
SERVE_PID=""
cleanup() {
  if [ -n "$SERVE_PID" ] && kill -0 "$SERVE_PID" 2>/dev/null; then kill "$SERVE_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

MIG_COUNT="$(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.js' | wc -l | tr -d ' ')"
info "迁移文件数：${MIG_COUNT}（目录 ${MIGRATIONS_DIR}）"

# run_migrate <描述> <日志文件> <migrate 子命令与参数...>
# 注意：PocketBase 0.28 的 migrate 命令迁移失败时也可能以退出码 0 结束（错误只打印到输出），
# 因此必须同时检查退出码与输出中的 Error 行。
run_migrate() {
  local desc="$1" log="$2"
  shift 2
  local code=0
  "$PB" migrate "$@" --dir "$DATA_DIR" --migrationsDir "$MIGRATIONS_DIR" --hooksDir "$HOOKS_DIR" > "$log" 2>&1 || code=$?
  if [ "$code" -ne 0 ] || grep -q '^Error' "$log"; then
    bad "${desc}（失败，输出如下）"
    cat "$log"
    exit 1
  fi
  ok "${desc}（Applied/Reverted 行数：$(grep -cE '^(Applied|Reverted)' "$log" || true)）"
}

# --- 2. 空库 migrate up ---------------------------------------------------------
info "步骤 1/5：空库 migrate up"
run_migrate "migrate up（空库）成功" "$WORK/up1.log" up

# --- 3. 单独回滚 seed 迁移，验证推文与审计成对清理 -------------------------------
# T2 migration 位于 seed 之后；回滚 2 个迁移才能覆盖 seed，随后 migrate up 恢复二者。
info "步骤 2/5：回滚 T2 + seed 迁移 → 校验无孤儿审计 → 再 migrate up"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATA_DIR/data.db" <<'SQL'
INSERT INTO organizations
  (id, name, status, require_activity_approval, allow_sensitive_export, remark, created, updated)
VALUES
  ('migpageorg00001', '迁移分页机构', 'active', 0, 0, '',
   '2026-08-29 00:00:00.000Z', '2026-08-29 00:00:00.000Z');
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 501)
INSERT INTO activities
  (id, organization_id, title, activity_code, description, location,
   start_time, end_time, status, capacity_total, capacity_speaker, capacity_listener,
   registration_open, registration_start_at, registration_end_at, checkin_qr_token,
   group_tag, form_config_json, created, updated,
   pairing_started_at, pairing_started_by, onsite_locked_at, onsite_locked_by,
   next_speaker_sequence, next_listener_sequence)
SELECT printf('migpageact%05d', n), 'migpageorg00001', '迁移分页活动',
       printf('CC_MIG_PAGE_%05d', n), '', '',
       '2099-01-01 10:00:00.000Z', '2099-01-01 12:00:00.000Z', 'draft', 2, 1, 1,
       0, '', '', printf('mig_page_token_%05d', n), '', '{}',
       '2026-08-29 00:00:00.000Z', '2026-08-29 00:00:00.000Z',
       '', '', '', '', 7, 8
FROM seq;
SQL
  check_eq "T2 回滚前已造 501 条跨页存量活动" \
    "$(sqlite3 "$DATA_DIR/data.db" "SELECT count(*) FROM activities WHERE organization_id='migpageorg00001';")" "501"
fi
echo y | run_migrate "migrate down T2 + seed 迁移成功" "$WORK/down_seed.log" down 2
if command -v sqlite3 >/dev/null 2>&1; then
  SEED_POSTS="$(sqlite3 "$DATA_DIR/data.db" "SELECT count(*) FROM posts WHERE id IN ('postreview00001','postreview00002');")"
  check_eq "单独 down 后两条 seed 推文均已删除" "$SEED_POSTS" "0"
  SEED_AUDITS="$(sqlite3 "$DATA_DIR/data.db" "SELECT count(*) FROM audit_logs WHERE action='post.create' AND target_type='post' AND target_id IN ('postreview00001','postreview00002');")"
  check_eq "单独 down 后 seed 审计无孤儿记录" "$SEED_AUDITS" "0"
else
  info "未安装 sqlite3，跳过单独 down 后 seed 推文/审计计数检查"
fi
run_migrate "单独 down 后再次 migrate up 成功" "$WORK/up_seed.log" up
if command -v sqlite3 >/dev/null 2>&1; then
  BACKFILLED_ACTIVITIES="$(sqlite3 "$DATA_DIR/data.db" "SELECT count(*) FROM activities WHERE organization_id='migpageorg00001' AND next_speaker_sequence=1 AND next_listener_sequence=1;")"
  check_eq "T2 分页回填覆盖全部 501 条存量活动" "$BACKFILLED_ACTIVITIES" "501"
  SEED_AUDITS="$(sqlite3 "$DATA_DIR/data.db" "SELECT count(*) FROM audit_logs WHERE action='post.create' AND target_type='post' AND target_id IN ('postreview00001','postreview00002') AND actor_id='system' AND actor_role='system';")"
  check_eq "再次 up 后恰有两条 system seed 审计" "$SEED_AUDITS" "2"
fi

# --- 4. migrate down 全部 → 再 up（往返） ---------------------------------------
info "步骤 3/5：migrate down ${MIG_COUNT}（全部回滚）→ 再 migrate up"
# migrate down 会交互式询问确认（非交互环境默认取消），用 echo y 管道确认
echo y | run_migrate "migrate down 全部回滚成功" "$WORK/down.log" down "$MIG_COUNT"

if command -v sqlite3 >/dev/null 2>&1; then
  # 回滚后 25 个业务集合应全部不存在（PocketBase 系统集合与本版本默认 users 集合不受影响）
  LEFT="$(sqlite3 "$DATA_DIR/data.db" "SELECT count(*) FROM _collections WHERE name IN ('organizations','admin_invites','admin_accounts','participant_accounts','activities','activity_approvals','registration_field_defs','registrations','registration_answers','checkin_sessions','checkins','activity_pairs','survey_templates','survey_template_versions','activity_surveys','survey_questions','submissions','answers','export_jobs','audit_logs','trainings','training_checkin_sessions','training_attendances','reports','posts');")"
  check_eq "down 后 25 个业务集合全部不存在" "$LEFT" "0"
else
  info "未安装 sqlite3，跳过 down 后集合计数检查"
fi

run_migrate "再次 migrate up（down→up 往返）成功" "$WORK/up2.log" up

# --- 4. serve + API 抽查 ---------------------------------------------------------
info "步骤 4/5：创建超管并启动 serve"
"$PB" superuser create smoke@example.com smoke-pass-123 --dir "$DATA_DIR" > /dev/null 2>&1
"$PB" serve --dir "$DATA_DIR" --migrationsDir "$MIGRATIONS_DIR" --hooksDir "$HOOKS_DIR" --http "127.0.0.1:$PORT" > "$WORK/serve.log" 2>&1 &
SERVE_PID=$!

for _ in $(seq 1 30); do
  if curl -fsS "$BASE/api/health" > /dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -fsS "$BASE/api/health" > /dev/null 2>&1; then
  bad "serve 启动失败"; tail -20 "$WORK/serve.log"; exit 1
fi
ok "serve 启动成功（含 /api/health）"
# hooks 自定义端点仍在（backend/pb_hooks/main.pb.js）
check_eq "hooks 健康检查 /api/cc/health" "$(curl -fsS "$BASE/api/cc/health" | json_val "d.get('ok')")" "True"

STOKEN="$(curl -fsS -X POST "$BASE/api/collections/_superusers/auth-with-password" \
  -H 'Content-Type: application/json' -d '{"identity":"smoke@example.com","password":"smoke-pass-123"}' | json_val "d['token']")"
if [ -n "$STOKEN" ]; then ok "超管认证成功"; else bad "超管认证失败"; exit 1; fi

info "步骤 5/5：API 抽查（集合存在性 / 未认证拒绝 / 规则与唯一索引）"

# 4.1 25 个业务集合全部存在
EXPECTED="organizations admin_invites admin_accounts participant_accounts activities activity_approvals registration_field_defs registrations registration_answers checkin_sessions checkins activity_pairs survey_templates survey_template_versions activity_surveys survey_questions submissions answers export_jobs audit_logs trainings training_checkin_sessions training_attendances reports posts"
NAMES="$(curl -fsS "$BASE/api/collections?perPage=100" -H "Authorization: $STOKEN" | json_val "' '.join(sorted(c['name'] for c in d['items']))")"
for name in $EXPECTED; do
  case " $NAMES " in
    *" $name "*) ok "集合存在：$name" ;;
    *) bad "集合缺失：$name" ;;
  esac
done

# 4.2 未认证访问
# 规则为 null 的集合（admin_invites）应直接拒绝
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/admin_invites/records")"
check_eq "未认证 list admin_invites 被拒（401/403）" "$([ "$CODE" = 401 ] || [ "$CODE" = 403 ] && echo yes || echo "no:$CODE")" "yes"
# 规则非空的集合按过滤返回空集（无公开活动广场，FR-ACT-002）
EMPTY="$(curl -fsS "$BASE/api/collections/activities/records" | json_val "d['totalItems']")"
check_eq "未认证 list activities 为空集" "$EMPTY" "0"
EMPTY="$(curl -fsS "$BASE/api/collections/audit_logs/records" | json_val "d['totalItems']")"
check_eq "未认证 list audit_logs 为空集" "$EMPTY" "0"

# 数据迁移：原前端写死的两条测试回顾已成为公开 visible 推文
REVIEW_1="$(curl -fsS "$BASE/api/collections/posts/records/postreview00001")"
check_eq "测试回顾 1 已迁移为公开推文" \
  "$(printf '%s' "$REVIEW_1" | json_val "d.get('title')")" \
  "首场活动回顾｜当 13 位青年遇见 15 位倾听者"
check_eq "测试回顾 1 状态为 visible" \
  "$(printf '%s' "$REVIEW_1" | json_val "d.get('status')")" "visible"
check_eq "测试回顾 1 摘要保持原文" \
  "$(printf '%s' "$REVIEW_1" | json_val "d.get('summary')")" \
  "正念开场、一杯饮品、60 分钟一对一对话——回顾 2026 年 6 月 12 日的首场 Chat Circles，看看那个下午发生了什么。"
REVIEW_2="$(curl -fsS "$BASE/api/collections/posts/records/postreview00002")"
check_eq "测试回顾 2 已迁移为公开推文" \
  "$(printf '%s' "$REVIEW_2" | json_val "d.get('title')")" \
  "倾听者手记｜不给建议，也是一种温柔"
check_eq "测试回顾 2 状态为 visible" \
  "$(printf '%s' "$REVIEW_2" | json_val "d.get('status')")" "visible"
check_eq "测试回顾 2 摘要保持原文" \
  "$(printf '%s' "$REVIEW_2" | json_val "d.get('summary')")" \
  "「我学到的最重要的事：把建议咽回去，把耳朵递过去。」一位企业员工倾听者的第一次服务记录。"

# 4.3 造数（超管通道，绕过 API Rules 但受唯一索引约束）
post() { # post <collection> <json> -> stdout
  curl -s -X POST "$BASE/api/collections/$1/records" -H "Authorization: $STOKEN" -H 'Content-Type: application/json' -d "$2"
}
ORG_A="$(post organizations '{"name":"机构A","status":"active","require_activity_approval":false,"allow_sensitive_export":true}' | json_val "d['id']")"
ORG_B="$(post organizations '{"name":"机构B","status":"active","require_activity_approval":true,"allow_sensitive_export":false}' | json_val "d['id']")"
ADMIN_A="$(post admin_accounts "{\"username\":\"admin_a1\",\"password\":\"pass123456\",\"passwordConfirm\":\"pass123456\",\"organization_id\":\"$ORG_A\",\"status\":\"active\"}" | json_val "d['id']")"
P1="$(post participant_accounts '{"username":"smoke_p1","password":"pass123456","passwordConfirm":"pass123456","status":"active"}' | json_val "d['id']")"
ACT_PUB="$(post activities "{\"organization_id\":\"$ORG_A\",\"title\":\"已发布活动\",\"activity_code\":\"CC_SA_202608_01\",\"start_time\":\"2026-08-10 10:00:00.000Z\",\"end_time\":\"2026-08-10 12:00:00.000Z\",\"status\":\"published\",\"capacity_total\":10,\"capacity_speaker\":5,\"capacity_listener\":5,\"registration_open\":true,\"checkin_qr_token\":\"tok_pub_1\"}" | json_val "d['id']")"
ACT_DRAFT="$(post activities "{\"organization_id\":\"$ORG_A\",\"title\":\"草稿活动\",\"activity_code\":\"CC_SA_202608_02\",\"start_time\":\"2026-08-11 10:00:00.000Z\",\"end_time\":\"2026-08-11 12:00:00.000Z\",\"status\":\"draft\",\"capacity_total\":10,\"capacity_speaker\":5,\"capacity_listener\":5,\"registration_open\":true,\"checkin_qr_token\":\"tok_draft_1\"}" | json_val "d['id']")"
ACT_B="$(post activities "{\"organization_id\":\"$ORG_B\",\"title\":\"机构B活动（草稿）\",\"activity_code\":\"CC_SB_202608_01\",\"start_time\":\"2026-08-12 10:00:00.000Z\",\"end_time\":\"2026-08-12 12:00:00.000Z\",\"status\":\"draft\",\"capacity_total\":10,\"capacity_speaker\":5,\"capacity_listener\":5,\"registration_open\":true,\"checkin_qr_token\":\"tok_b_1\"}" | json_val "d['id']")"
if [ -n "$ORG_A" ] && [ -n "$ORG_B" ] && [ -n "$ADMIN_A" ] && [ -n "$P1" ] && [ -n "$ACT_PUB" ] && [ -n "$ACT_DRAFT" ] && [ -n "$ACT_B" ]; then
  ok "fixture 造数成功（2 机构 / 1 管理员 / 1 参与者 / 3 活动）"
else
  bad "fixture 造数失败"; exit 1
fi

# 4.4 公开活动详情：原生 viewRule 已收紧为仅本机构管理员（迁移 20），
#     匿名/参与者公开访问一律走 /api/cc/public/activities 白名单端点（FR-ACT-003）
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/activities/records/$ACT_PUB")"
check_eq "未认证 view published 活动 = 404（原生公开 view 已关闭）" "$CODE" "404"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/cc/public/activities/$ACT_PUB")"
check_eq "未认证走公开端点 view published 活动 = 200" "$CODE" "200"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/activities/records/$ACT_DRAFT")"
check_eq "未认证 view draft 活动 = 404" "$CODE" "404"

# 4.5 registrations 复合唯一索引（参与者×活动唯一，FR-REG-003）
REG_BODY="{\"activity_id\":\"$ACT_PUB\",\"participant_id\":\"$P1\",\"activity_role\":\"speaker\",\"status\":\"pending\",\"submitted_at\":\"2026-08-05 02:00:00.000Z\"}"
REG1="$(post registrations "$REG_BODY" | json_val "d.get('id')")"
check_eq "首条报名创建成功" "$([ -n "$REG1" ] && echo yes || echo no)" "yes"
DUP_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/collections/registrations/records" -H "Authorization: $STOKEN" -H 'Content-Type: application/json' -d "$REG_BODY")"
check_eq "重复报名被唯一索引拒绝（400）" "$DUP_CODE" "400"

# 4.6 参与者身份规则
PTOKEN="$(curl -s -X POST "$BASE/api/collections/participant_accounts/auth-with-password" -H 'Content-Type: application/json' -d '{"identity":"smoke_p1","password":"pass123456"}' | json_val "d.get('token')")"
check_eq "参与者 username 认证成功（identityFields=username）" "$([ -n "$PTOKEN" ] && echo yes || echo no)" "yes"
OWN="$(curl -s "$BASE/api/collections/registrations/records" -H "Authorization: $PTOKEN" | json_val "d['totalItems']")"
check_eq "参与者 list registrations 仅本人（=1）" "$OWN" "1"
EMPTY="$(curl -s "$BASE/api/collections/activities/records" -H "Authorization: $PTOKEN" | json_val "d['totalItems']")"
check_eq "参与者 list activities 为空集（无广场）" "$EMPTY" "0"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/organizations/records/$ORG_A")"
check_eq "参与者 view organizations 被拒（404）" "$CODE" "404"

# 4.7 管理员机构隔离（AC-03 基础）
ATOKEN="$(curl -s -X POST "$BASE/api/collections/admin_accounts/auth-with-password" -H 'Content-Type: application/json' -d '{"identity":"admin_a1","password":"pass123456"}' | json_val "d.get('token')")"
check_eq "管理员 username 认证成功" "$([ -n "$ATOKEN" ] && echo yes || echo no)" "yes"
MINE="$(curl -s "$BASE/api/collections/activities/records?perPage=100" -H "Authorization: $ATOKEN" | json_val "d['totalItems']")"
check_eq "机构A管理员 list activities 仅本机构（=2）" "$MINE" "2"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/collections/activities/records/$ACT_B" -H "Authorization: $ATOKEN")"
check_eq "机构A管理员 view 机构B草稿活动 = 404（跨机构隔离）" "$CODE" "404"

# 4.8 无硬删除与写保护（FR-AUD-001 / FR-AUD-005）
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/collections/registrations/records/$REG1" -H "Authorization: $ATOKEN")"
check_eq "管理员 delete 报名被拒（403/404）" "$([ "$CODE" = 403 ] || [ "$CODE" = 404 ] && echo yes || echo "no:$CODE")" "yes"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/collections/audit_logs/records" -H "Authorization: $ATOKEN" -H 'Content-Type: application/json' -d "{\"actor_id\":\"$ADMIN_A\",\"actor_role\":\"admin\",\"organization_id\":\"$ORG_A\",\"action\":\"test.probe\",\"target_type\":\"x\",\"target_id\":\"y\",\"result\":\"success\"}")"
check_eq "管理员 create audit_logs 被拒（403/404）" "$([ "$CODE" = 403 ] || [ "$CODE" = 404 ] && echo yes || echo "no:$CODE")" "yes"

# --- 5. 汇总 ---------------------------------------------------------------------
echo
echo "==============================================="
echo "迁移冒烟结果：PASS=$PASS FAIL=$FAIL"
echo "==============================================="
[ "$FAIL" = 0 ]
