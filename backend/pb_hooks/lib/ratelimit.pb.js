// lib/ratelimit.pb.js — 登录失败限流（checkRateLimit，原子「检查即预占」）
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
// 状态存储（安全审查 finding 2/7，CWE-362 修复）：原实现用 $app.store() 做「功能上先 get 检查、
// 业务后再 set 写回」的非原子计数，并发请求可同时读到旧计数并相互覆盖，从而绕过阈值。
// $app.store() 无原子自增原语；故改为 DB 记录 + $app.runInTransaction 实现原子性：
// 事务内「读→过滤窗口→判定是否超限→未超则预占一格并写回」，写冲突由 SQLite 忙等重试收敛
// （≤2 次，同 checkins/trainings 既有做法）。状态存 cc_rate_counters 集合（迁移 1787895600），
// 每键一行，slots 为 json 数组（滑动窗口内的失败/尝试时间戳，epoch 秒）。
//
// ⚠️ json 字段读取约定：PocketBase 0.28 JSVM 的 record.get('json字段') 返回原始 JSON 字节数组
// 或字符串（非 JS 数组），须经 ccRateSlots() 解码后再用（与全仓 decodeJson 用法一致）。
//
// 预占语义：checkRateLimit 返回 true 即已为本次尝试预占一格（失败即计入窗口）；
// 成功路径用 resetRateLimit 清空（「连续失败」语义），或对「只计失败、成功不计」的桶
// （如 auth.pb.js 的喷洒限流）用 releaseRateLimit 回滚这格预占。
//
// 用法：
//   if (!checkRateLimit(key, 5, 600)) → 拒绝（429）
//   失败       → 该格已计入窗口，无需再 record
//   成功       → resetRateLimit(key)           （「连续失败」语义）
//              或 releaseRateLimit(key)        （「只计失败」语义，如喷洒限流）
//   多键同时   → tryReserveMany([{key,max,window},...])（all-or-none，如 phoneauth）

/** 限流键统一前缀（避免与其他用途冲突；各调用方按需复用本前缀）。 */
function ccRlKey(key) {
  return 'cc_rl|' + key;
}

/** 当前 epoch 秒。 */
function ccRateNow() {
  return Math.floor(Date.now() / 1000);
}

/** SQLite 忙/锁/快照冲突判定（用于事务内写冲突忙等重试）。 */
function ccRateIsBusy(err) {
  return !!err && /busy|locked|snapshot/i.test(String((err && err.message) || err));
}

/** 读一条计数记录；无此键返回 null（不抛 no-rows）。 */
function ccRateOne(app, key) {
  try {
    return app.findFirstRecordByFilter('cc_rate_counters', 'key = {:k}', { k: key });
  } catch (err) {
    if (!!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0) return null;
    throw err;
  }
}

/** 解码 json 字段 slots → 时间戳数组（epoch 秒）。PB 0.28 读 json 字段返回字节数组/字符串。 */
function ccRateSlots(rec) {
  const v = rec && rec.get('slots');
  if (v === null || v === undefined || v === '') return [];
  let parsed = null;
  if (typeof v === 'string') {
    try { parsed = JSON.parse(v); } catch (_) { /* fallthrough */ }
  } else if (Array.isArray(v)) {
    const first = v[0];
    if (typeof first === 'number' && first > 128) {
      parsed = v; // 已是时间戳数组（epoch 秒 >> ASCII）
    } else if (typeof first === 'number' && v.length === 0) {
      parsed = []; // 空数组
    } else if (typeof first === 'number') {
      // 原始 JSON 字节数组（0-255）：还原为字符串再解析
      let s = '';
      for (const b of v) s += String.fromCharCode(b);
      try { parsed = JSON.parse(s); } catch (_) { /* fallthrough */ }
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((x) => typeof x === 'number');
}

/**
 * 原子「检查即预占」：在事务内读该键当前窗口计数，若已 >= max 返回 false（不预占），
 * 否则预占一格（追加当前时间戳）并返回 true。忙等重试 ≤2 次，仍忙则保守返回 false
 * （fail-closed：宁可拒绝也不让计数被并发突破）。
 * @param {string} key 逻辑限流键（经 ccRlKey 加前缀后存储）
 * @param {number} max 窗口内允许的最大次数
 * @param {number} windowSec 滑动窗口秒数
 * @returns {boolean} true=允许(且已预占一格)；false=已超限拒绝(未预占)
 */
function checkRateLimit(key, max, windowSec) {
  const k = ccRlKey(key);
  const now = ccRateNow();
  let allowed = false;
  let attempts = 0;
  for (;;) {
    try {
      $app.runInTransaction((txApp) => {
        const rec = ccRateOne(txApp, k);
        const kept = ccRateSlots(rec).filter((ts) => ts > now - windowSec);
        if (kept.length >= max) {
          allowed = false; // 已超限：不预占
          return;
        }
        kept.push(now);
        if (!rec) {
          const col = txApp.findCollectionByNameOrId('cc_rate_counters');
          const created = new Record(col);
          created.set('key', k);
          created.set('slots', kept);
          txApp.save(created);
        } else {
          rec.set('slots', kept);
          txApp.save(rec);
        }
        allowed = true;
      });
      break;
    } catch (err) {
      if (ccRateIsBusy(err) && attempts < 2) {
        attempts++;
        continue;
      }
      if (ccRateIsBusy(err)) {
        allowed = false; // 持续忙：fail-closed 拒绝，不允许并发突破
        break;
      }
      throw err;
    }
  }
  return allowed;
}

/**
 * 多键原子「检查即预占」（all-or-none）：事务内同时检查全部键，任一已超限则整体拒绝且一个
 * 都不预占；全部未超限则同时为各键预占一格。用于 phoneauth 等「同请求需同时通过多个桶、
 * 任一超限即整体拒绝」的限流。
 * @param {Array<{key:string,max:number,window:number}>} keys
 * @returns {boolean} true=全部允许且均已预占；false=存在超限（均未预占）
 */
function tryReserveMany(keys) {
  const now = ccRateNow();
  let allowed = false;
  let attempts = 0;
  for (;;) {
    try {
      $app.runInTransaction((txApp) => {
        const rows = keys.map(({ key }) => ccRateOne(txApp, ccRlKey(key)));
        // rows 与 keys 按索引对齐：逐键应用各自 window 过滤
        const slotsAll = rows.map((rec, i) =>
          ccRateSlots(rec).filter((ts) => ts > now - keys[i].window),
        );
        // 任一超出对应阈值 → 整体拒绝（不预占任何键）
        for (let i = 0; i < keys.length; i++) {
          if (slotsAll[i].length >= keys[i].max) {
            allowed = false;
            return;
          }
        }
        for (let i = 0; i < keys.length; i++) {
          const col = txApp.findCollectionByNameOrId('cc_rate_counters');
          const slots = slotsAll[i];
          slots.push(now);
          if (rows[i]) {
            rows[i].set('slots', slots);
            txApp.save(rows[i]);
          } else {
            const created = new Record(col);
            created.set('key', ccRlKey(keys[i].key));
            created.set('slots', slots);
            txApp.save(created);
          }
        }
        allowed = true;
      });
      break;
    } catch (err) {
      if (ccRateIsBusy(err) && attempts < 2) {
        attempts++;
        continue;
      }
      if (ccRateIsBusy(err)) {
        allowed = false; // fail-closed
        break;
      }
      throw err;
    }
  }
  return allowed;
}

/** 成功后清除该 key 的全部失败记录（「连续失败」语义）。 */
function resetRateLimit(key) {
  const k = ccRlKey(key);
  $app.runInTransaction((txApp) => {
    const rec = ccRateOne(txApp, k);
    if (rec) txApp.delete(rec);
  });
}

/** 回滚该键最近一次预占（best-effort）。用于「只计失败、成功不计」的桶（如喷洒限流）。 */
function releaseRateLimit(key) {
  const k = ccRlKey(key);
  $app.runInTransaction((txApp) => {
    const rec = ccRateOne(txApp, k);
    if (!rec) return;
    const slots = ccRateSlots(rec);
    slots.pop(); // 移除最新一格（本请求的预占；并发同秒多请求时近似，见文件头说明）
    if (slots.length === 0) {
      txApp.delete(rec);
    } else {
      rec.set('slots', slots);
      txApp.save(rec);
    }
  });
}
