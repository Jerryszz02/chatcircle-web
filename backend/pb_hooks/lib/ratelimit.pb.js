// lib/ratelimit.pb.js — 登录失败限流（checkRateLimit）
//
// 契约（technical-design §5.4、security-privacy §9、FR-AUTH-007、AC-21）：
// - 同一 username + 来源 IP 连续失败达阈值后临时拒绝；阈值/窗口为常量
//   （PRD 未给数值，technical-design 待确认 #1：本实现取 5 次失败 / 10 分钟滑动窗口，
//   窗口内失败数达上限即拒绝，最早一次失败滑出窗口后自动恢复，即「临时限制」）。
// - 限流响应不得泄露账号是否存在（security-privacy §9、test-plan §3 限流套件）。
//
// ⚠️ 重要集成说明（PocketBase 0.28.4 实测）：JSVM 各 hooks 文件作用域完全隔离，
// 顶层 var/function/const/globalThis 均不跨文件可见，亦无 ES module import 支持。
// 因此本文件是契约的「标准源」：调用方将以下函数原样内联到自己的 handler 闭包内使用
// （后端 A 的 auth.pb.js 即按此模式集成；后端 B 同）。
//
// 状态存储：$app.store()（Go 侧共享 KV）。JSVM 请求间无可靠 JS 内存可共享
// （handler 运行在隔离作用域），进程内存方案在此版本不可用；
// $app.store() 为单实例进程内 KV，适配单实例部署（V1 不引入 Redis 等外部组件）。
//
// 用法：
//   if (!checkRateLimit(key, 5, 600)) → 拒绝（429）
//   密码校验失败 → recordRateLimitFailure(key, 600)
//   校验成功       → resetRateLimit(key)

/** 限流键统一前缀（避免与其他 store 用途冲突）。 */
function ccRlKey(key) {
  return 'cc_rl|' + key;
}

/**
 * 检查 key 当前是否允许继续尝试。
 * @param {string} key 限流键（建议 '用途|用户名|IP'）
 * @param {number} max 窗口内允许的最大失败次数
 * @param {number} windowSec 滑动窗口秒数
 * @returns {boolean} true=允许（窗口内失败数未达上限）；false=临时拒绝
 */
function checkRateLimit(key, max, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const kept = ($app.store().get(ccRlKey(key)) || []).filter((ts) => ts > now - windowSec);
  return kept.length < max;
}

/** 记录一次失败（窗口内累计）。 */
function recordRateLimitFailure(key, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const k = ccRlKey(key);
  const kept = ($app.store().get(k) || []).filter((ts) => ts > now - windowSec);
  kept.push(now);
  $app.store().set(k, kept);
}

/** 成功后清除该 key 的全部失败记录（「连续失败」语义）。 */
function resetRateLimit(key) {
  $app.store().remove(ccRlKey(key));
}
