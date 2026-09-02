// auth.pb.js — 认证 hooks：存量参与者登录 + 管理员邀请码注册
//
// 端点契约（technical-design §5.4，统一端点契约）：
// - POST /api/cc/auth/participant {username, password}
//     T1 后仅供存量用户名账号迁移：用户名小写归一化，只校验已存在账号；
//     不存在与密码错误返回相同响应，绝不创建未验证手机号的新账号；返回 { token, record }；
//     同人同 IP 连续失败限流（FR-AUTH-007，常量 5 次 / 10 分钟滑动窗口）；
//     同 IP 跨用户名失败累计限流（防密码喷洒，30 次 / 10 分钟）；
//     密码格式校验前置到账号 lookup 之前（消除账号枚举 oracle）。
// - POST /api/cc/auth/admin-register {invite_code, username, email, password}
//     事务内消费一次性邀请码创建管理员（FR-ORG-002/003、AC-02；邮箱为 2026-08 改版新增，AC-24）：
//     校验未使用/未撤销/未过期 → 邮箱格式校验与查重 → 创建 admin_accounts 绑机构
//     （verified=false、emailVisibility=false）→ 置 used → 写审计（metadata 不含邮箱明文）。
//     发送验证邮件不在本端点做（外部副作用不入事务）：由前端在注册成功后调用
//     PB 内置 POST /api/collections/admin_accounts/request-verification 触发（mailguard.pb.js 限流）。
// 邀请码哈希算法：SHA-256 hex（生成端 POST /api/cc/super/invites 必须使用同一算法）。
// ⚠️ 本文件为「handler 自包含」模式（PocketBase 0.28.4 实测约束）：
// JSVM 各 hooks 文件顶层声明在请求处理时不可见（无跨文件全局共享、无 ES module），
// 每个 handler 只能使用自身闭包内的标识符与 JSVM 内建全局（$app / ApiError / Record 等）。
// 各 handler 顶部的共享函数与 lib/*.pb.js 契约同源（由生成器按引用自动内联，勿手工改副本）。

// ---------------------------------------------------------------------------
// POST /api/cc/auth/participant — 存量参与者登录（T1 迁移兼容、AC-06/AC-21）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/auth/participant', (e) => {
  try {
  // 统一错误：抛出标记对象，由 handler 顶层 catch 转为统一 JSON 错误响应
  // （new ApiError 的第三参数会被当作字段错误映射转换，无法携带自定义 data，0.28.4 实测）
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const ccIsNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
  const ccOne = (app, collection, filter, params) => {
    try { return app.findFirstRecordByFilter(collection, filter, params || {}); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  // 登录限流（与 lib/ratelimit.pb.js 原子版同源）：状态存 cc_rate_counters 集合，
  // DB 事务「检查即预占」（安全审查 finding 2/7、CWE-362 修复）——$app.store() 无原子自增
  // 原语，原「先 get 检查、业务后再 set 写回」的非原子计数可被并发请求突破阈值。
  // 语义不变：滑动窗口内失败达上限即临时拒绝；响应不泄露账号是否存在。
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
  // epoch 秒 → PB 日期时间字符串（与库内 ccNow 同款）
  const ccRateDt = (epochSec) => new Date(epochSec * 1000).toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  // 过期限流键垃圾回收（best-effort，P2：DB 持久化后防止废弃键无限增长）；store 节流，失败不影响主流程
  const ccRateGc = () => {
    try {
      const GC_INTERVAL_SEC = 600;
      const GC_TTL_SEC = 3600;
      const now = Math.floor(Date.now() / 1000);
      const last = Number($app.store().get('cc_rl_gc_last') || 0);
      if (now - last < GC_INTERVAL_SEC) return;
      const cutoff = ccRateDt(now - GC_TTL_SEC);
      $app.runInTransaction((txApp) => {
        const stale = txApp.findRecordsByFilter('cc_rate_counters', 'updated < {:t}', '', 500, 0, { t: cutoff });
        for (const rec of stale) txApp.delete(rec);
      });
      $app.store().set('cc_rl_gc_last', String(now));
    } catch (_) { /* best-effort */ }
  };
  const checkRateLimit = (key, max, windowSec) => {
    ccRateGc(); // 节流 GC 废弃键（best-effort）
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
  const releaseRateLimit = (key) => { // 回滚最近一次预占（「只计失败」语义，best-effort）
    const k = ccRlKey(key);
    $app.runInTransaction((txApp) => {
      const rec = ccRateOne(txApp, k);
      if (!rec) return;
      const slots = ccRateSlots(rec);
      slots.pop();
      if (slots.length === 0) txApp.delete(rec); else { rec.set('slots', slots); txApp.save(rec); }
    });
  };
  // 用户名规则（FR-AUTH-005）：4–20 位字母/数字/下划线，存储统一小写（大小写不敏感唯一）
  const CC_USERNAME_RE = /^[a-z0-9_]{4,20}$/;
  // 登录限流常量（PRD 未给数值，technical-design 待确认 #1）：同一 username + IP 10 分钟窗口 5 次失败（AC-21）
  const CC_LOGIN_MAX_FAILURES = 5;
  const CC_LOGIN_WINDOW_SEC = 600;
  // 密码长度策略：PocketBase 默认 ≥8；上限 71 防 bcrypt 截断歧义（PRD 未写死，能力层）
  const CC_PASSWORD_MIN = 8;
  const CC_PASSWORD_MAX = 71;
  // 喷洒限流：同一来源 IP 跨用户名累计密码失败 30 次 / 10 分钟窗口（防密码喷洒；
  // 只计失败不计成功，避免共享出口（NAT/校园网）正常用户互相误伤）
  const CC_SPRAY_MAX_FAILURES = 30;
  const CC_SPRAY_WINDOW_SEC = 600;
  const body = e.requestInfo().body || {};
  const username = String(body.username == null ? '' : body.username).trim().toLowerCase();
  if (!CC_USERNAME_RE.test(username)) {
    ccError(400, 'INVALID_USERNAME', '用户名须为 4–20 位字母、数字或下划线');
  }
  const password = body.password;
  if (typeof password !== 'string' || password === '') {
    ccError(400, 'INVALID_PASSWORD', '请输入密码');
  }
  // 长度校验前置到账号 lookup 之前（枚举收敛）：新旧账号先过同一格式校验，
  // 消除「不存在账号先撞格式错误」的账号枚举 oracle；ACCOUNT_DISABLED 语义不变
  if (password.length < CC_PASSWORD_MIN || password.length > CC_PASSWORD_MAX) {
    ccError(400, 'INVALID_PASSWORD', '密码长度须为 ' + CC_PASSWORD_MIN + '–' + CC_PASSWORD_MAX + ' 位');
  }

  // 限流（原子「检查即预占」）：同一用户名 + 来源 IP 连续失败达阈值后临时拒绝；
  // 响应不泄露账号是否存在。rateKey 预占格在成功时清空（连续失败语义），
  // sprayKey 预占格在成功时回滚（只计失败语义，避免共享出口正常用户互相误伤）。
  const rateKey = 'participant|' + username + '|' + e.realIP();
  // 喷洒限流：同一来源 IP 跨用户名累计失败（成功不清零，窗口滑出自动恢复）
  const sprayKey = 'participant_ip|' + e.realIP();
  if (!checkRateLimit(rateKey, CC_LOGIN_MAX_FAILURES, CC_LOGIN_WINDOW_SEC) ||
      !checkRateLimit(sprayKey, CC_SPRAY_MAX_FAILURES, CC_SPRAY_WINDOW_SEC)) {
    ccError(429, 'TOO_MANY_ATTEMPTS', '尝试次数过多，请稍后再试');
  }

  const lookup = () => ccOne($app, 'participant_accounts', 'username = {:u}', { u: username });
  const record = lookup();
  // T1 后用户名入口仅用于迁移已有账号。未知用户名与错误密码必须同形响应，
  // 且不能创建账号或签发 token，否则可绕过手机号验证直接进入参与者业务端点。
  if (!record || !record.validatePassword(password)) {
    // 失败：rateKey / sprayKey 的预占格在 checkRateLimit 时已计入窗口，无需再 record
    ccError(400, 'INVALID_CREDENTIALS', '用户名或密码错误');
  }
  if (record.get('status') !== 'active') {
    ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
  }

  // 成功：rateKey（连续失败）清空；sprayKey（只计失败）回滚本次预占
  resetRateLimit(rateKey);
  releaseRateLimit(sprayKey);
  return e.json(200, { token: record.newAuthToken(), record: record, created: false });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/auth/admin-register — 一次性邀请码注册管理员（FR-ORG-002/003、AC-02；
// 邮箱必填为 2026-08 改版新增，AC-24）
// 单事务：校验邀请码 → 邮箱格式校验与查重 → 创建 admin_accounts → 邀请码置 used → 写审计。
// 并发使用同一邀请码只能成功一次（事务串行化 + 状态重读）。
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/auth/admin-register', (e) => {
  try {
  const ccIsNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
  const ccById = (app, collection, id) => {
    try { return app.findRecordById(collection, id); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  // 统一错误：抛出标记对象，由 handler 顶层 catch 转为统一 JSON 错误响应
  // （new ApiError 的第三参数会被当作字段错误映射转换，无法携带自定义 data，0.28.4 实测）
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const ccNow = () => new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  const ccOne = (app, collection, filter, params) => {
    try { return app.findFirstRecordByFilter(collection, filter, params || {}); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const ccUniqueErr = (err) => !!err && typeof err.message === 'string' && /unique/i.test(err.message);
  // 写一条审计日志（与 lib/audit.pb.js 同源；事务内传 txApp，同事务提交）
  const writeAudit = (app, entry) => {
    const collection = app.findCollectionByNameOrId('audit_logs');
    const record = new Record(collection);
    record.set('actor_id', entry.actorId);
    record.set('actor_role', entry.actorRole);
    record.set('organization_id', entry.organizationId || '');
    record.set('action', entry.action);
    record.set('target_type', entry.targetType);
    record.set('target_id', entry.targetId);
    record.set('result', entry.result);
    record.set('reason', entry.reason || '');
    record.set('metadata', entry.metadata || null);
    app.save(record);
    return record;
  };
  const CC_USERNAME_RE = /^[a-z0-9_]{4,20}$/;
  // 邮箱格式校验（简版；投递可达性由验证邮件闭环，AC-24）
  const CC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const CC_PASSWORD_MIN = 8;
  const CC_PASSWORD_MAX = 71;

  const body = e.requestInfo().body || {};
  // 契约参数为 invite_code（前端 shared/api/http.ts 已对齐）；兼容历史 inviteCode 命名
  const inviteCode = body.invite_code != null ? body.invite_code : body.inviteCode;
  if (typeof inviteCode !== 'string' || inviteCode.trim() === '') {
    ccError(400, 'INVALID_INVITE', '请输入邀请码');
  }
  // 管理员用户名规则 PRD 未明确（technical-design 待确认 #3），暂套用参与者同一套（含小写归一化）
  const username = String(body.username == null ? '' : body.username).trim().toLowerCase();
  if (!CC_USERNAME_RE.test(username)) {
    ccError(400, 'INVALID_USERNAME', '用户名须为 4–20 位字母、数字或下划线');
  }
  // 邮箱必填（2026-08 改版）：trim + 小写归一化（大小写不敏感唯一，PB email 唯一约束兜底）
  const email = String(body.email == null ? '' : body.email).trim().toLowerCase();
  if (email === '' || email.length > 254 || !CC_EMAIL_RE.test(email)) {
    ccError(400, 'INVALID_EMAIL', '邮箱格式不正确');
  }
  const password = body.password;
  if (typeof password !== 'string' || password.length < CC_PASSWORD_MIN || password.length > CC_PASSWORD_MAX) {
    ccError(400, 'INVALID_PASSWORD', '密码长度须为 ' + CC_PASSWORD_MIN + '–' + CC_PASSWORD_MAX + ' 位');
  }
  const tokenHash = $security.sha256(inviteCode.trim());

  // 过期固化（PRD §4.2 四态）：先于主事务执行——事务内抛错回滚会把固化一并撤销
  const preInvite = ccOne($app, 'admin_invites', 'token_hash = {:h}', { h: tokenHash });
  if (preInvite && preInvite.get('status') === 'unused' &&
      String(preInvite.get('expires_at')) <= ccNow()) {
    preInvite.set('status', 'expired');
    $app.save(preInvite);
  }

  let admin = null;
  $app.runInTransaction((txApp) => {
    const invite = ccOne(txApp, 'admin_invites', 'token_hash = {:h}', { h: tokenHash });
    if (!invite) {
      ccError(400, 'INVALID_INVITE', '邀请码无效');
    }
    const status = invite.get('status');
    if (status === 'expired') {
      ccError(400, 'INVITE_EXPIRED', '邀请码已过期');
    }
    if (status !== 'unused') {
      ccError(400, 'INVITE_INVALID', '邀请码已使用或已撤销');
    }

    const orgId = invite.get('organization_id');
    const org = ccById(txApp, 'organizations', orgId);
    if (!org || org.get('status') !== 'active') {
      ccError(400, 'ORG_DISABLED', '所属机构已停用，无法注册');
    }

    // 用户名占用预检（大小写不敏感唯一：存储统一小写 + 唯一索引兜底）
    if (ccOne(txApp, 'admin_accounts', 'username = {:u}', { u: username })) {
      ccError(400, 'USERNAME_TAKEN', '用户名已被使用');
    }
    // 邮箱占用预检（存储统一小写；唯一约束由 PB auth 集合 email 字段兜底）
    if (ccOne(txApp, 'admin_accounts', 'email = {:m}', { m: email })) {
      ccError(400, 'EMAIL_TAKEN', '邮箱已被使用');
    }
    const collection = txApp.findCollectionByNameOrId('admin_accounts');
    admin = new Record(collection);
    admin.set('username', username);
    admin.set('email', email);
    admin.set('emailVisibility', false);
    admin.set('verified', false); // 注册后须经 PB 内置验证邮件完成验证（AC-24）
    admin.set('password', password);
    admin.set('organization_id', orgId);
    admin.set('status', 'active');
    admin.set('display_name', '');
    try {
      txApp.save(admin);
    } catch (err) {
      if (ccUniqueErr(err)) {
        // 唯一冲突兜底：用户名或邮箱命中其一
        ccError(400, 'USERNAME_TAKEN', '用户名或邮箱已被使用');
      }
      throw err;
    }

    // 同事务消费邀请码（一次性，AC-02）
    invite.set('status', 'used');
    invite.set('used_by', admin.id);
    invite.set('used_at', ccNow());
    txApp.save(invite);

    // 审计：邀请码使用（security-privacy §8.1 账号类），与业务写同事务
    writeAudit(txApp, {
      actorId: admin.id,
      actorRole: 'admin',
      organizationId: orgId,
      action: 'invite.use',
      targetType: 'admin_invite',
      targetId: invite.id,
      result: 'success',
      metadata: { username: username },
    });
  });

  return e.json(200, { record: admin });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});
