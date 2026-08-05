// auth.pb.js — 认证 hooks：参与者自动注册/登录 + 管理员邀请码注册
//
// 端点契约（technical-design §5.4，统一端点契约）：
// - POST /api/cc/auth/participant {username, password}
//     用户名小写归一化；不存在则创建并登录，存在则校验密码；
//     错误密码不得创建重复账号（AC-06）；返回 { token, record }；
//     同人同 IP 连续失败限流（FR-AUTH-007，常量 5 次 / 10 分钟滑动窗口）。
// - POST /api/cc/auth/admin-register {invite_code, username, password}
//     事务内消费一次性邀请码创建管理员（FR-ORG-002/003、AC-02）：
//     校验未使用/未撤销/未过期 → 创建 admin_accounts 绑机构 → 置 used → 写审计。
// 邀请码哈希算法：SHA-256 hex（生成端 POST /api/cc/super/invites 必须使用同一算法）。
// ⚠️ 本文件为「handler 自包含」模式（PocketBase 0.28.4 实测约束）：
// JSVM 各 hooks 文件顶层声明在请求处理时不可见（无跨文件全局共享、无 ES module），
// 每个 handler 只能使用自身闭包内的标识符与 JSVM 内建全局（$app / ApiError / Record 等）。
// 各 handler 顶部的共享函数与 lib/*.pb.js 契约同源（由生成器按引用自动内联，勿手工改副本）。

// ---------------------------------------------------------------------------
// POST /api/cc/auth/participant — 参与者自动注册/登录（FR-AUTH-001~008、AC-06/AC-21）
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
  // 登录限流（与 lib/ratelimit.pb.js 同源）：状态存 $app.store()（Go 侧共享 KV，
  // JSVM 请求间无 JS 内存可共享）；滑动窗口内失败达上限即临时拒绝
  const ccRlKey = (key) => 'cc_rl|' + key;
  const checkRateLimit = (key, max, windowSec) => {
    const now = Math.floor(Date.now() / 1000);
    const kept = ($app.store().get(ccRlKey(key)) || []).filter((ts) => ts > now - windowSec);
    return kept.length < max;
  };
  const recordRateLimitFailure = (key, windowSec) => {
    const now = Math.floor(Date.now() / 1000);
    const k = ccRlKey(key);
    const kept = ($app.store().get(k) || []).filter((ts) => ts > now - windowSec);
    kept.push(now);
    $app.store().set(k, kept);
  };
  const resetRateLimit = (key) => { $app.store().remove(ccRlKey(key)); };
  const ccUniqueErr = (err) => !!err && typeof err.message === 'string' && /unique/i.test(err.message);
  // 用户名规则（FR-AUTH-005）：4–20 位字母/数字/下划线，存储统一小写（大小写不敏感唯一）
  const CC_USERNAME_RE = /^[a-z0-9_]{4,20}$/;
  // 登录限流常量（PRD 未给数值，technical-design 待确认 #1）：同一 username + IP 10 分钟窗口 5 次失败（AC-21）
  const CC_LOGIN_MAX_FAILURES = 5;
  const CC_LOGIN_WINDOW_SEC = 600;
  // 密码长度策略：PocketBase 默认 ≥8；上限 71 防 bcrypt 截断歧义（PRD 未写死，能力层）
  const CC_PASSWORD_MIN = 8;
  const CC_PASSWORD_MAX = 71;

  const body = e.requestInfo().body || {};
  const username = String(body.username == null ? '' : body.username).trim().toLowerCase();
  if (!CC_USERNAME_RE.test(username)) {
    ccError(400, 'INVALID_USERNAME', '用户名须为 4–20 位字母、数字或下划线');
  }
  const password = body.password;
  if (typeof password !== 'string' || password === '') {
    ccError(400, 'INVALID_PASSWORD', '请输入密码');
  }

  // 限流：同一用户名 + 来源 IP 连续失败达阈值后临时拒绝；响应不泄露账号是否存在
  const rateKey = 'participant|' + username + '|' + e.realIP();
  if (!checkRateLimit(rateKey, CC_LOGIN_MAX_FAILURES, CC_LOGIN_WINDOW_SEC)) {
    ccError(429, 'TOO_MANY_ATTEMPTS', '尝试次数过多，请稍后再试');
  }

  const lookup = () => ccOne($app, 'participant_accounts', 'username = {:u}', { u: username });
  let record = lookup();
  let created = false;

  if (!record) {
    // 用户名不存在 → 自动注册并登录（FR-AUTH-001）
    if (password.length < CC_PASSWORD_MIN || password.length > CC_PASSWORD_MAX) {
      ccError(400, 'INVALID_PASSWORD', '密码长度须为 ' + CC_PASSWORD_MIN + '–' + CC_PASSWORD_MAX + ' 位');
    }
    const collection = $app.findCollectionByNameOrId('participant_accounts');
    record = new Record(collection);
    record.set('username', username);
    record.set('password', password);
    record.set('status', 'active');
    try {
      $app.save(record);
      created = true;
    } catch (err) {
      // 并发同名注册：唯一索引兜底（AC-06 任何情况下不产生重复账号），转为密码校验路径
      if (!ccUniqueErr(err)) throw err;
      record = lookup();
      if (!record) throw err;
    }
  }

  if (!created) {
    // 用户名已存在（含并发撞号回退）→ 校验密码；错误密码不建号（AC-06）
    if (record.get('status') !== 'active') {
      ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
    }
    if (!record.validatePassword(password)) {
      recordRateLimitFailure(rateKey, CC_LOGIN_WINDOW_SEC);
      ccError(400, 'INVALID_CREDENTIALS', '用户名或密码错误');
    }
  }

  resetRateLimit(rateKey);
  return e.json(200, { token: record.newAuthToken(), record: record, created: created });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/auth/admin-register — 一次性邀请码注册管理员（FR-ORG-002/003、AC-02）
// 单事务：校验邀请码 → 创建 admin_accounts → 邀请码置 used → 写审计。
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
    const collection = txApp.findCollectionByNameOrId('admin_accounts');
    admin = new Record(collection);
    admin.set('username', username);
    admin.set('password', password);
    admin.set('organization_id', orgId);
    admin.set('status', 'active');
    admin.set('display_name', '');
    try {
      txApp.save(admin);
    } catch (err) {
      if (ccUniqueErr(err)) {
        ccError(400, 'USERNAME_TAKEN', '用户名已被使用');
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

