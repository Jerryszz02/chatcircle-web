// authguard.pb.js — PB 内置 auth-with-password 端点限流（防暴破/密码喷洒）
//
// 背景：自定义参与者端点 /api/cc/auth/participant 已有 username+IP 失败限流
// （auth.pb.js，FR-AUTH-007/AC-21），但 PB 内置认证端点
// （/api/collections/{participant_accounts,admin_accounts,_superusers}/auth-with-password）
// 本身无限流，可被直接用于暴破管理员/超管口令。本文件为内置端点补限流。
//
// 0.28.4 JSVM 实测约束（探针实证，非文档推断）：
// - 无 onRequest 全局中间件（typeof onRequest === 'undefined'）；对本需求可用的钩子是
//   onRecordAuthWithPasswordRequest：密码校验之前触发、身份不存在时 e.record 为 nil、
//   不传集合参数时覆盖包括 _superusers 在内的全部 auth 集合。
// - 该钩子事件内 e.request 为 undefined（与路由 handler 不同）；
//   e.realIP() / e.requestInfo() / e.json / e.collection / e.record 可用。
// - return e.json(status, body) 可直接短路请求（认证处理器不再执行），
//   因此 429 响应能保持 { code, message, data: { code } } 统一错误形态。
// - e.next() 在认证失败时抛出 JS 异常（可 try/catch 精确区分成功/失败），
//   成功时正常返回（返回值为 undefined，原样 return 即可）。
// - e.realIP() 默认取 TCP peer（不读 X-Forwarded-For/X-Real-IP）；生产经 Caddy
//   反代时须在控制台 Settings 启用 trusted proxy headers，否则 per-IP 限流
//   退化为全平台共享桶。
//
// 规则（窗口与 auth.pb.js 参与者端点对齐）：
// - per-IP 频率限制：10 分钟滑窗内 25 次认证尝试（含成功），超限 429 TOO_MANY_ATTEMPTS
//   （2026-08 改版由 20 上调：管理员邮箱+密码登录复用本端点，集成测试预算随之上调）；
// - per-身份+IP 失败限流：10 分钟滑窗内 5 次失败，超限 429 TOO_MANY_ATTEMPTS
//   （同 AC-21「连续失败」语义），认证成功清除该身份的失败计数。
// 状态存 cc_rate_counters 集合（DB 事务「检查即预占」，安全审查 finding 2/7、CWE-362 修复；
// 迁移 1787895600），键前缀 cc_rl|；
// 限流函数与 lib/ratelimit.pb.js 契约同源（JSVM 无跨文件共享，按约定内联，勿手工改副本）。

onRecordAuthWithPasswordRequest((e) => {
  // 登录限流（与 lib/ratelimit.pb.js 原子版同源）：状态存 cc_rate_counters 集合，
  // DB 事务「检查即预占」（安全审查 finding 2/7、CWE-362 修复）——$app.store() 无原子自增
  // 原语，原「先 get 检查、业务后再 set 写回」的非原子计数可被并发请求突破阈值。
  // 语义不变：per-IP 计每次尝试；per-身份+IP 计失败、成功清除。
  const ccRlKey = (key) => 'cc_rl|' + key;
  const ccRateNow = () => Math.floor(Date.now() / 1000);
  const ccRateIsBusy = (err) => !!err && /busy|locked|snapshot/i.test(String((err && err.message) || err));
  const ccRateOne = (app, key) => {
    try { return app.findFirstRecordByFilter('cc_rate_counters', 'key = {:k}', { k: key }); }
    catch (err) { if (!!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0) return null; throw err; }
  };
  // json 字段读取解码（PB 0.28 读 json 字段返回原始 JSON 字节数组/字符串，非 JS 数组）
  const ccRateSlots = (rec) => {
    const v = rec && rec.get('slots');
    if (v === null || v === undefined || v === '') return [];
    let parsed = null;
    if (typeof v === 'string') { try { parsed = JSON.parse(v); } catch (_) { /* fallthrough */ } }
    else if (Array.isArray(v)) {
      const first = v[0];
      if (typeof first === 'number' && first > 128) { parsed = v; } // 已是时间戳数组
      else if (typeof first === 'number' && v.length === 0) { parsed = []; }
      else if (typeof first === 'number') { // 原始 JSON 字节数组（0-255）还原为字符串再解析
        let s = '';
        for (const b of v) s += String.fromCharCode(b);
        try { parsed = JSON.parse(s); } catch (_) { /* fallthrough */ }
      }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => typeof x === 'number');
  };
  const checkRateLimit = (key, max, windowSec) => {
    const k = ccRlKey(key);
    const now = ccRateNow();
    let allowed = false;
    let attempts = 0;
    for (;;) {
      try {
        $app.runInTransaction((txApp) => {
          const rec = ccRateOne(txApp, k);
          const kept = ccRateSlots(rec).filter((ts) => ts > now - windowSec);
          if (kept.length >= max) { allowed = false; return; }
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
        if (ccRateIsBusy(err) && attempts < 2) { attempts++; continue; }
        if (ccRateIsBusy(err)) { allowed = false; break; } // fail-closed：拒绝而非放行
        throw err;
      }
    }
    return allowed;
  };
  const resetRateLimit = (key) => {
    const k = ccRlKey(key);
    $app.runInTransaction((txApp) => {
      const rec = ccRateOne(txApp, k);
      if (rec) txApp.delete(rec);
    });
  };
  // 限流常量：per-IP 10 分钟 25 次尝试（防暴破兜底）；per-身份+IP 10 分钟 5 次失败（对齐 AC-21）
  const CC_AUTHPW_IP_MAX = 25;
  const CC_AUTHPW_FAIL_MAX = 5;
  const CC_AUTHPW_WINDOW_SEC = 600;
  const ccTooMany = () => e.json(429, { code: 429, message: '尝试次数过多，请稍后再试', data: { code: 'TOO_MANY_ATTEMPTS' } });

  const ip = e.realIP();
  const body = e.requestInfo().body || {};
  // 身份归一化（小写 + 截断）：防大小写变体绕计数、防异常长 identity 撑爆键空间
  const identity = String(body.identity == null ? '' : body.identity).trim().toLowerCase().slice(0, 128);
  const coll = e.collection ? e.collection.name : '';

  // per-IP 频率限制：密码校验前无法区分成败，所有尝试先查后计（checkRateLimit 已预占一格，
  // 无需再单独 record；第 max+1 次起拒绝）
  const ipKey = 'authpw|' + ip;
  if (!checkRateLimit(ipKey, CC_AUTHPW_IP_MAX, CC_AUTHPW_WINDOW_SEC)) {
    return ccTooMany();
  }

  // per-身份+IP 失败限流
  const failKey = 'authpw_f|' + coll + '|' + identity + '|' + ip;
  if (!checkRateLimit(failKey, CC_AUTHPW_FAIL_MAX, CC_AUTHPW_WINDOW_SEC)) {
    return ccTooMany();
  }

  try {
    const res = e.next();
    resetRateLimit(failKey); // 认证成功清除失败计数（「连续失败」语义，同 AC-21）
    return res;
  } catch (err) {
    // 认证失败（e.next() 实测以 JS 异常抛出）→ failKey 预占格已计入窗口，原样上抛，响应形态不变
    throw err;
  }
});
