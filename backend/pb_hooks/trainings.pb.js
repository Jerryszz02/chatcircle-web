// trainings.pb.js — 聆听者培训 hooks：培训生命周期、签到场次开放/关闭、自助签到、补签、撤销
//
// 端点契约（technical-design §5.5、database-design 培训体系，统一端点契约）：
// - POST /api/cc/trainings/{id}/publish|close          管理员状态机（draft → published → closed）
// - POST /api/cc/trainings/{id}/checkin/open|close     管理员开放/关闭签到（可重复开放/关闭）
// - POST /api/cc/training-checkin/self { token }                参与者自助签到（按 checkin_qr_token
//     定位培训；幂等，重复扫码返回已有记录）
// - POST /api/cc/training-checkins/manual {training_id, participant_id, reason}   管理员补签（原因必填）
// - GET  /api/cc/trainings/{id}/checkin/manual-candidates       补签候选人名单（按用户名选择）
// - POST /api/cc/training-checkins/{id}/revoke {reason}         管理员撤销签到（原因必填）
// - GET  /api/cc/me/trainings                          参与者培训页聚合（资格 + 列表 + 我的签到状态）
//
// 关键规则（镜像 checkins.pb.js 签到模式，培训与活动解绑）：
// - 签到前置：登录 + 存在 approved 的聆听者报名（全平台任一活动，资格账号级通用，
//   否则 403 listener_not_approved）+ 培训已 published + 签到开放中；未签到不建行；
// - 每培训每人仅一条 valid 记录：SQLite 无法表达部分唯一，由事务内查重保证；撤销行保留；
// - 补签/撤销仅管理端，必须填 reason 并写审计；
// - 「培训通过」为账号级标记：任一培训存在 valid 出席记录即 trained，全平台通用。
// 机构隔离：管理端点忽略客户端机构参数，机构范围从登录管理员身份注入（FR-ORG-006）；
// 跨机构一律 404（不泄露存在性，AC-03）。
// ⚠️ 本文件为「handler 自包含」模式（PocketBase 0.28.4 实测约束）：
// JSVM 各 hooks 文件顶层声明在请求处理时不可见（无跨文件全局共享、无 ES module），
// 每个 handler 只能使用自身闭包内的标识符与 JSVM 内建全局（$app / ApiError / Record 等）。
// 各 handler 顶部的共享函数与 lib/*.pb.js 契约同源（由生成器按引用自动内联，勿手工改副本）。

// ---------------------------------------------------------------------------
// POST /api/cc/trainings/{id}/publish — 发布培训（draft → published；幂等：已发布返回现状）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/trainings/{id}/publish', (e) => {
  try {
  const ccIsNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
  const ccById = (app, collection, id) => {
    try { return app.findRecordById(collection, id); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  // 统一错误：抛出标记对象，由 handler 顶层 catch 转为统一 JSON 错误响应
  // （new ApiError 的第三参数会被当作字段错误映射转换，无法携带自定义 data，0.28.4 实测）
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  // 身份守卫（与 lib/http.pb.js 同源）；admin 同时校验账号与所属机构 status（FR-ORG-001）
  const requireAuth = (e, role) => {
    const auth = e.auth;
    if (!auth) ccError(401, 'UNAUTHORIZED', '请先登录');
    const collectionName = auth.collection().name;
    if (role === 'participant') {
      if (collectionName !== 'participant_accounts') ccError(403, 'FORBIDDEN', '无权限：需要参与者身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      return auth;
    }
    if (role === 'admin') {
      if (collectionName !== 'admin_accounts') ccError(403, 'FORBIDDEN', '无权限：需要机构管理员身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      const org = ccById(e.app, 'organizations', auth.get('organization_id'));
      if (!org || org.get('status') !== 'active') ccError(403, 'ORG_DISABLED', '所属机构已停用');
      return auth;
    }
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };
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
  const admin = requireAuth(e, 'admin');
  const orgId = admin.get('organization_id');
  const training = ccById($app, 'trainings', e.request.pathValue('id'));
  if (!training || training.get('organization_id') !== orgId) {
    ccError(404, 'TRAINING_NOT_FOUND', '培训不存在');
  }
  if (training.get('status') === 'published') {
    return e.json(200, { training: training, already: true });
  }
  if (training.get('status') !== 'draft') {
    ccError(400, 'ILLEGAL_TRANSITION', '仅草稿状态可发布');
  }

  $app.runInTransaction((txApp) => {
    const fresh = txApp.findRecordById('trainings', training.id);
    if (fresh.get('status') === 'published') return;
    if (fresh.get('status') !== 'draft') {
      ccError(409, 'CONCURRENT_MODIFICATION', '培训状态已被变更，请刷新后重试');
    }
    fresh.set('status', 'published');
    txApp.save(fresh);
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'admin', organizationId: orgId,
      action: 'training.publish', targetType: 'training', targetId: fresh.id,
      result: 'success', metadata: { from: 'draft', to: 'published' },
    });
  });

  return e.json(200, { training: $app.findRecordById('trainings', training.id), already: false });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/trainings/{id}/close — 关闭培训（published → closed；幂等）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/trainings/{id}/close', (e) => {
  try {
  const ccIsNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
  const ccById = (app, collection, id) => {
    try { return app.findRecordById(collection, id); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const ccNow = () => new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  const requireAuth = (e, role) => {
    const auth = e.auth;
    if (!auth) ccError(401, 'UNAUTHORIZED', '请先登录');
    const collectionName = auth.collection().name;
    if (role === 'participant') {
      if (collectionName !== 'participant_accounts') ccError(403, 'FORBIDDEN', '无权限：需要参与者身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      return auth;
    }
    if (role === 'admin') {
      if (collectionName !== 'admin_accounts') ccError(403, 'FORBIDDEN', '无权限：需要机构管理员身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      const org = ccById(e.app, 'organizations', auth.get('organization_id'));
      if (!org || org.get('status') !== 'active') ccError(403, 'ORG_DISABLED', '所属机构已停用');
      return auth;
    }
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };
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
  const admin = requireAuth(e, 'admin');
  const orgId = admin.get('organization_id');
  const training = ccById($app, 'trainings', e.request.pathValue('id'));
  if (!training || training.get('organization_id') !== orgId) {
    ccError(404, 'TRAINING_NOT_FOUND', '培训不存在');
  }
  if (training.get('status') === 'closed') {
    return e.json(200, { training: training, already: true });
  }
  if (training.get('status') !== 'published') {
    ccError(400, 'ILLEGAL_TRANSITION', '仅已发布培训可关闭');
  }

  $app.runInTransaction((txApp) => {
    const fresh = txApp.findRecordById('trainings', training.id);
    if (fresh.get('status') === 'closed') return;
    if (fresh.get('status') !== 'published') {
      ccError(409, 'CONCURRENT_MODIFICATION', '培训状态已被变更，请刷新后重试');
    }
    fresh.set('status', 'closed');
    txApp.save(fresh);
    // 联合同步关闭仍 open 的签到场次：培训关闭后管理端不再提供关闭会话入口，
    // 残留 open 会话会造成「培训已关闭但签到仍开放」的矛盾状态
    const closedAt = ccNow();
    const openSessions = txApp.findRecordsByFilter(
      'training_checkin_sessions', "training_id = {:t} && status = 'open'", '', 500, 0, { t: fresh.id },
    );
    openSessions.forEach((s) => {
      s.set('status', 'closed');
      s.set('closed_at', closedAt);
      txApp.save(s);
    });
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'admin', organizationId: orgId,
      action: 'training.close', targetType: 'training', targetId: fresh.id,
      result: 'success',
      metadata: { from: 'published', to: 'closed', closed_open_sessions: openSessions.length },
    });
  });

  return e.json(200, { training: $app.findRecordById('trainings', training.id), already: false });
  } catch (err) {
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/trainings/{id}/checkin/open — 开放签到（幂等：已开放返回现有场次；
// 同一培训同一时间至多一条 open 记录，事务保证）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/trainings/{id}/checkin/open', (e) => {
  try {
  const ccIsNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
  const ccById = (app, collection, id) => {
    try { return app.findRecordById(collection, id); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const ccNow = () => new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  const ccOne = (app, collection, filter, params) => {
    try { return app.findFirstRecordByFilter(collection, filter, params || {}); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const requireAuth = (e, role) => {
    const auth = e.auth;
    if (!auth) ccError(401, 'UNAUTHORIZED', '请先登录');
    const collectionName = auth.collection().name;
    if (role === 'participant') {
      if (collectionName !== 'participant_accounts') ccError(403, 'FORBIDDEN', '无权限：需要参与者身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      return auth;
    }
    if (role === 'admin') {
      if (collectionName !== 'admin_accounts') ccError(403, 'FORBIDDEN', '无权限：需要机构管理员身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      const org = ccById(e.app, 'organizations', auth.get('organization_id'));
      if (!org || org.get('status') !== 'active') ccError(403, 'ORG_DISABLED', '所属机构已停用');
      return auth;
    }
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };
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
  const admin = requireAuth(e, 'admin');
  const orgId = admin.get('organization_id');
  const training = ccById($app, 'trainings', e.request.pathValue('id'));
  if (!training || training.get('organization_id') !== orgId) {
    ccError(404, 'TRAINING_NOT_FOUND', '培训不存在');
  }
  // 仅已发布培训可开放签到（草稿/已关闭不可）
  if (training.get('status') !== 'published') {
    ccError(400, 'TRAINING_NOT_OPEN', '培训当前状态不可开放签到');
  }

  let session = null;
  let created = false;
  $app.runInTransaction((txApp) => {
    session = ccOne(txApp, 'training_checkin_sessions', "training_id = {:t} && status = 'open'", { t: training.id });
    if (session) return; // 幂等：已有开放中场次
    const collection = txApp.findCollectionByNameOrId('training_checkin_sessions');
    session = new Record(collection);
    session.set('training_id', training.id);
    session.set('status', 'open');
    session.set('opened_at', ccNow());
    session.set('opened_by', admin.id);
    txApp.save(session);
    created = true;
    // 审计：培训签到开放
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'admin', organizationId: orgId,
      action: 'training.checkin_open', targetType: 'training_checkin_session', targetId: session.id,
      result: 'success', metadata: { training_id: training.id },
    });
  });

  return e.json(200, { session: session, created: created });
  } catch (err) {
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/trainings/{id}/checkin/close — 关闭签到（幂等：无开放场次为空操作）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/trainings/{id}/checkin/close', (e) => {
  try {
  const ccIsNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
  const ccById = (app, collection, id) => {
    try { return app.findRecordById(collection, id); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const ccNow = () => new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  const ccOne = (app, collection, filter, params) => {
    try { return app.findFirstRecordByFilter(collection, filter, params || {}); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const requireAuth = (e, role) => {
    const auth = e.auth;
    if (!auth) ccError(401, 'UNAUTHORIZED', '请先登录');
    const collectionName = auth.collection().name;
    if (role === 'participant') {
      if (collectionName !== 'participant_accounts') ccError(403, 'FORBIDDEN', '无权限：需要参与者身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      return auth;
    }
    if (role === 'admin') {
      if (collectionName !== 'admin_accounts') ccError(403, 'FORBIDDEN', '无权限：需要机构管理员身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      const org = ccById(e.app, 'organizations', auth.get('organization_id'));
      if (!org || org.get('status') !== 'active') ccError(403, 'ORG_DISABLED', '所属机构已停用');
      return auth;
    }
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };
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
  const admin = requireAuth(e, 'admin');
  const orgId = admin.get('organization_id');
  const training = ccById($app, 'trainings', e.request.pathValue('id'));
  if (!training || training.get('organization_id') !== orgId) {
    ccError(404, 'TRAINING_NOT_FOUND', '培训不存在');
  }

  let session = null;
  let closed = false;
  $app.runInTransaction((txApp) => {
    session = ccOne(txApp, 'training_checkin_sessions', "training_id = {:t} && status = 'open'", { t: training.id });
    if (!session) return; // 幂等：本就未开放
    session.set('status', 'closed');
    session.set('closed_at', ccNow());
    txApp.save(session);
    closed = true;
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'admin', organizationId: orgId,
      action: 'training.checkin_close', targetType: 'training_checkin_session', targetId: session.id,
      result: 'success', metadata: { training_id: training.id },
    });
  });

  return e.json(200, { session: session, closed: closed });
  } catch (err) {
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/training-checkin/self — 参与者自助签到
// 入参 { token }：培训固定签到二维码 token（checkin_qr_token），查无 404。
// 校验链：登录 → 按 token 找培训（须 published）→ 资格（存在 approved 聆听者报名，
// 否则 403 listener_not_approved）→ 有 open 场次（checkin_not_open / checkin_closed）→
// 事务内幂等查重（已有 valid 直接返回成功）→ 写 training_attendances + 审计。
// 幂等：重复扫码返回已有有效签到，不报错不新建。
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/training-checkin/self', (e) => {
  try {
  const ccIsNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
  const ccById = (app, collection, id) => {
    try { return app.findRecordById(collection, id); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const ccNow = () => new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  const ccOne = (app, collection, filter, params) => {
    try { return app.findFirstRecordByFilter(collection, filter, params || {}); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const requireAuth = (e, role) => {
    const auth = e.auth;
    if (!auth) ccError(401, 'UNAUTHORIZED', '请先登录');
    const collectionName = auth.collection().name;
    if (role === 'participant') {
      if (collectionName !== 'participant_accounts') ccError(403, 'FORBIDDEN', '无权限：需要参与者身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      return auth;
    }
    if (role === 'admin') {
      if (collectionName !== 'admin_accounts') ccError(403, 'FORBIDDEN', '无权限：需要机构管理员身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      const org = ccById(e.app, 'organizations', auth.get('organization_id'));
      if (!org || org.get('status') !== 'active') ccError(403, 'ORG_DISABLED', '所属机构已停用');
      return auth;
    }
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };
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
  const participant = requireAuth(e, 'participant');
  // 入参为签到二维码 token（二维码内容为 /training-checkin/<token> 落地链接）；
  // body 类型校验（L1）：非字符串直接 400
  const body = e.requestInfo().body || {};
  const token = body.token;
  if (typeof token !== 'string' || token === '') {
    ccError(400, 'INVALID_TOKEN', '缺少有效的签到二维码 token');
  }
  const training = ccOne($app, 'trainings', 'checkin_qr_token = {:t}', { t: token });
  if (!training) {
    ccError(404, 'TRAINING_NOT_FOUND', '培训不存在或签到二维码无效');
  }
  const trainingId = training.id;
  // 仅已发布培训可签到（草稿/已关闭不可）
  if (training.get('status') !== 'published') {
    ccError(400, 'CHECKIN_UNAVAILABLE', '培训当前不可签到');
  }

  // 资格与场次开放校验移入事务内（消除事务外 TOCTOU）；
  // SQLite 快照冲突/SQLITE_BUSY 类错误最多重试 2 次，仍失败返回 409 CONFLICT
  const isBusyErr = (err) => !!err && /busy|locked|snapshot/i.test(String((err && err.message) || err));
  let attendance = null;
  let created = false;
  let attempts = 0;
  for (;;) {
    try {
      $app.runInTransaction((txApp) => {
        // 签到前置：存在 approved 的聆听者报名（账号级资格，全平台任一活动通用）
        const eligible = !!ccOne(
          txApp, 'registrations',
          "participant_id = {:p} && activity_role = 'listener' && status = 'approved'",
          { p: participant.id },
        );
        if (!eligible) {
          ccError(403, 'listener_not_approved', '聆听者报名审核通过后才能参加培训签到');
        }

        // 幂等：已有有效签到直接返回（重复扫码/网络重试）；
        // 每培训每人仅一条 valid（并发扫码兜底）
        attendance = ccOne(
          txApp, 'training_attendances',
          "training_id = {:t} && participant_id = {:p} && status = 'valid'",
          { t: trainingId, p: participant.id },
        );
        if (attendance) return;

        // 签到开放中校验：无开放场次时区分「未开放」（从未开放过）与「已结束」
        // （曾开放后关闭），前端按 checkin_not_open / checkin_closed 分开展示
        if (!ccOne(txApp, 'training_checkin_sessions', "training_id = {:t} && status = 'open'", { t: trainingId })) {
          const hadSession = ccOne(
            txApp, 'training_checkin_sessions', 'training_id = {:t}', { t: trainingId },
          );
          if (hadSession) {
            ccError(400, 'checkin_closed', '本场签到已结束');
          }
          ccError(400, 'checkin_not_open', '签到未开放');
        }

        const collection = txApp.findCollectionByNameOrId('training_attendances');
        attendance = new Record(collection);
        attendance.set('training_id', trainingId);
        attendance.set('participant_id', participant.id);
        attendance.set('source', 'self_scan');
        attendance.set('status', 'valid');
        attendance.set('checked_in_at', ccNow());
        attendance.set('operator_id', '');
        attendance.set('reason', '');
        txApp.save(attendance);
        created = true;
        // 审计：自助签到
        writeAudit(txApp, {
          actorId: participant.id, actorRole: 'participant',
          organizationId: training.get('organization_id'),
          action: 'training.attendance_self', targetType: 'training_attendance', targetId: attendance.id,
          result: 'success', metadata: { training_id: trainingId, source: 'self_scan' },
        });
      });
      break;
    } catch (err) {
      if (err && err.__ccError === true) throw err; // 业务错误不重试，顶层统一转换
      if (isBusyErr(err) && attempts < 2) {
        attempts++;
        continue;
      }
      if (isBusyErr(err)) {
        ccError(409, 'CONFLICT', '签到操作冲突，请稍后重试');
      }
      throw err;
    }
  }

  return e.json(200, { attendance: attendance, already_checked_in: !created });
  } catch (err) {
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/training-checkins/manual — 管理员补签（原因必填 + 审计；幂等）
// 参与者身份校验与自助签到同口径：须存在 approved 的聆听者报名。
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/training-checkins/manual', (e) => {
  try {
  const ccIsNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
  const ccById = (app, collection, id) => {
    try { return app.findRecordById(collection, id); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const ccNow = () => new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  const ccOne = (app, collection, filter, params) => {
    try { return app.findFirstRecordByFilter(collection, filter, params || {}); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const requireAuth = (e, role) => {
    const auth = e.auth;
    if (!auth) ccError(401, 'UNAUTHORIZED', '请先登录');
    const collectionName = auth.collection().name;
    if (role === 'participant') {
      if (collectionName !== 'participant_accounts') ccError(403, 'FORBIDDEN', '无权限：需要参与者身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      return auth;
    }
    if (role === 'admin') {
      if (collectionName !== 'admin_accounts') ccError(403, 'FORBIDDEN', '无权限：需要机构管理员身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      const org = ccById(e.app, 'organizations', auth.get('organization_id'));
      if (!org || org.get('status') !== 'active') ccError(403, 'ORG_DISABLED', '所属机构已停用');
      return auth;
    }
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };
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
  const admin = requireAuth(e, 'admin');
  const orgId = admin.get('organization_id');
  const body = e.requestInfo().body || {};
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason === '') {
    ccError(400, 'REASON_REQUIRED', '补签必须填写原因');
  }
  const training = ccById($app, 'trainings', body.training_id);
  if (!training || training.get('organization_id') !== orgId) {
    ccError(404, 'TRAINING_NOT_FOUND', '培训不存在');
  }
  const participantId = body.participant_id;
  if (typeof participantId !== 'string' || participantId === '') {
    ccError(400, 'INVALID_PARTICIPANT', '缺少 participant_id');
  }

  // 参与者身份校验同自助签到：须存在 approved 的聆听者报名
  const eligible = !!ccOne(
    $app, 'registrations',
    "participant_id = {:p} && activity_role = 'listener' && status = 'approved'",
    { p: participantId },
  );
  if (!eligible) {
    ccError(400, 'listener_not_approved', '该参与者聆听者报名未通过，不能补签');
  }

  // 幂等：已有有效签到返回现有记录；补签不要求签到场次开放
  let attendance = ccOne(
    $app, 'training_attendances',
    "training_id = {:t} && participant_id = {:p} && status = 'valid'",
    { t: training.id, p: participantId },
  );
  if (attendance) {
    return e.json(200, { attendance: attendance, existing: true });
  }

  let created = false;
  $app.runInTransaction((txApp) => {
    attendance = ccOne(
      txApp, 'training_attendances',
      "training_id = {:t} && participant_id = {:p} && status = 'valid'",
      { t: training.id, p: participantId },
    );
    if (attendance) return;
    const collection = txApp.findCollectionByNameOrId('training_attendances');
    attendance = new Record(collection);
    attendance.set('training_id', training.id);
    attendance.set('participant_id', participantId);
    attendance.set('source', 'manual');
    attendance.set('status', 'valid');
    attendance.set('checked_in_at', ccNow());
    attendance.set('operator_id', admin.id);
    attendance.set('reason', reason);
    txApp.save(attendance);
    created = true;
    // 审计：补签，原因必填
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'admin', organizationId: orgId,
      action: 'training.attendance_manual', targetType: 'training_attendance', targetId: attendance.id,
      result: 'success', reason: reason,
      metadata: { training_id: training.id, participant_id: participantId },
    });
  });

  return e.json(200, { attendance: attendance, existing: !created });
  } catch (err) {
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /api/cc/trainings/{id}/checkin/manual-candidates — 补签候选人名单
// 管理员不可读 participant_accounts 集合（listRule 关闭，无参与者名录），
// 补签下拉需要按用户名选择，故由服务端注入候选人 { participant_id, username }。
// 培训签到资格为账号级（全平台 approved 聆听者报名通用），候选人即该资格全集
// （按参与者去重）；不在名单内的参与者补签也会被服务端资格校验拒绝。
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/cc/trainings/{id}/checkin/manual-candidates', (e) => {
  try {
  const ccIsNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
  const ccById = (app, collection, id) => {
    try { return app.findRecordById(collection, id); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const requireAuth = (e, role) => {
    const auth = e.auth;
    if (!auth) ccError(401, 'UNAUTHORIZED', '请先登录');
    const collectionName = auth.collection().name;
    if (role === 'participant') {
      if (collectionName !== 'participant_accounts') ccError(403, 'FORBIDDEN', '无权限：需要参与者身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      return auth;
    }
    if (role === 'admin') {
      if (collectionName !== 'admin_accounts') ccError(403, 'FORBIDDEN', '无权限：需要机构管理员身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      const org = ccById(e.app, 'organizations', auth.get('organization_id'));
      if (!org || org.get('status') !== 'active') ccError(403, 'ORG_DISABLED', '所属机构已停用');
      return auth;
    }
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };
  const admin = requireAuth(e, 'admin');
  const orgId = admin.get('organization_id');
  const training = ccById($app, 'trainings', e.request.pathValue('id'));
  if (!training || training.get('organization_id') !== orgId) {
    ccError(404, 'TRAINING_NOT_FOUND', '培训不存在');
  }

  const listenerRegs = $app.findRecordsByFilter(
    'registrations', "activity_role = 'listener' && status = 'approved'", '', 5000, 0,
  );
  const seen = {};
  const candidates = [];
  listenerRegs.forEach((reg) => {
    const pid = reg.get('participant_id');
    if (seen[pid]) return; // 同一参与者多条 approved 聆听者报名只入一次
    seen[pid] = true;
    const participant = ccById($app, 'participant_accounts', pid);
    if (!participant) return; // 账号异常缺失时跳过，不阻断名单
    candidates.push({
      participant_id: participant.id,
      username: participant.get('username'),
    });
  });
  candidates.sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));

  return e.json(200, { candidates: candidates });
  } catch (err) {
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/training-checkins/{id}/revoke — 撤销签到（原因必填 + 审计；
// 只改状态不删行，原记录保留；幂等：已撤销返回原记录）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/training-checkins/{id}/revoke', (e) => {
  try {
  const ccIsNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
  const ccById = (app, collection, id) => {
    try { return app.findRecordById(collection, id); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const ccNow = () => new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  const requireAuth = (e, role) => {
    const auth = e.auth;
    if (!auth) ccError(401, 'UNAUTHORIZED', '请先登录');
    const collectionName = auth.collection().name;
    if (role === 'participant') {
      if (collectionName !== 'participant_accounts') ccError(403, 'FORBIDDEN', '无权限：需要参与者身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      return auth;
    }
    if (role === 'admin') {
      if (collectionName !== 'admin_accounts') ccError(403, 'FORBIDDEN', '无权限：需要机构管理员身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      const org = ccById(e.app, 'organizations', auth.get('organization_id'));
      if (!org || org.get('status') !== 'active') ccError(403, 'ORG_DISABLED', '所属机构已停用');
      return auth;
    }
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };
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
  const admin = requireAuth(e, 'admin');
  const orgId = admin.get('organization_id');
  const body = e.requestInfo().body || {};
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason === '') {
    ccError(400, 'REASON_REQUIRED', '撤销必须填写原因');
  }

  const attendanceId = e.request.pathValue('id');
  const attendance = ccById($app, 'training_attendances', attendanceId);
  if (!attendance) {
    ccError(404, 'ATTENDANCE_NOT_FOUND', '签到记录不存在');
  }
  // 机构隔离（经 training 反查，跨机构一律 404）
  const training = ccById($app, 'trainings', attendance.get('training_id'));
  if (!training || training.get('organization_id') !== orgId) {
    ccError(404, 'ATTENDANCE_NOT_FOUND', '签到记录不存在');
  }

  if (attendance.get('status') === 'revoked') {
    return e.json(200, { attendance: attendance, already_revoked: true });
  }

  let fresh = null;
  $app.runInTransaction((txApp) => {
    fresh = txApp.findRecordById('training_attendances', attendanceId);
    if (fresh.get('status') === 'revoked') return; // 并发撤销幂等
    fresh.set('status', 'revoked');
    fresh.set('revoked_at', ccNow());
    fresh.set('operator_id', admin.id);
    fresh.set('reason', reason);
    txApp.save(fresh);
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'admin', organizationId: orgId,
      action: 'training.attendance_revoke', targetType: 'training_attendance', targetId: attendanceId,
      result: 'success', reason: reason,
      metadata: {
        training_id: fresh.get('training_id'),
        participant_id: fresh.get('participant_id'),
        source: fresh.get('source'),
      },
    });
  });

  return e.json(200, { attendance: fresh, already_revoked: false });
  } catch (err) {
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /api/cc/me/trainings — 参与者培训页聚合
// 返回 { eligible, trained, trainings }：
// - eligible：存在 approved 的聆听者报名（未 eligible 时 trainings 恒为空，
//   培训信息只对审核通过的聆听者开放）；
// - trained：存在任一 valid 出席记录（账号级「培训通过」标记，全平台通用）；
// - trainings：全部 published 培训（不限机构）+ 本人有出席记录的 closed 培训，
//   每项 my_attendance = 本人最新一条出席 { status, checked_in_at } 或 null；
//   不下发 checkin_qr_token。
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/cc/me/trainings', (e) => {
  try {
  const ccIsNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
  const ccById = (app, collection, id) => {
    try { return app.findRecordById(collection, id); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const ccOne = (app, collection, filter, params) => {
    try { return app.findFirstRecordByFilter(collection, filter, params || {}); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const requireAuth = (e, role) => {
    const auth = e.auth;
    if (!auth) ccError(401, 'UNAUTHORIZED', '请先登录');
    const collectionName = auth.collection().name;
    if (role === 'participant') {
      if (collectionName !== 'participant_accounts') ccError(403, 'FORBIDDEN', '无权限：需要参与者身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      return auth;
    }
    if (role === 'admin') {
      if (collectionName !== 'admin_accounts') ccError(403, 'FORBIDDEN', '无权限：需要机构管理员身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
      const org = ccById(e.app, 'organizations', auth.get('organization_id'));
      if (!org || org.get('status') !== 'active') ccError(403, 'ORG_DISABLED', '所属机构已停用');
      return auth;
    }
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };
  const participant = requireAuth(e, 'participant');

  const eligible = !!ccOne(
    $app, 'registrations',
    "participant_id = {:p} && activity_role = 'listener' && status = 'approved'",
    { p: participant.id },
  );
  if (!eligible) {
    return e.json(200, { eligible: false, trained: false, trainings: [] });
  }

  // 本人全部出席记录（按签到时间倒序），按培训取最新一条作为 my_attendance
  const attendances = $app.findRecordsByFilter(
    'training_attendances', 'participant_id = {:p}', '-checked_in_at', 500, 0,
    { p: participant.id },
  );
  let trained = false;
  const myByTraining = {};
  attendances.forEach((a) => {
    if (a.get('status') === 'valid') trained = true;
    const tid = a.get('training_id');
    if (!myByTraining[tid]) myByTraining[tid] = a; // 倒序首个即最新
  });

  const toBrief = (t) => {
    const mine = myByTraining[t.id];
    return {
      id: t.id,
      title: t.get('title'),
      training_code: t.get('training_code'),
      description: t.get('description'),
      location: t.get('location'),
      start_time: t.get('start_time'),
      end_time: t.get('end_time'),
      status: t.get('status'),
      my_attendance: mine
        ? { status: mine.get('status'), checked_in_at: mine.get('checked_in_at') }
        : null,
    };
  };

  // 全部 published 培训（资质全平台通用，不限机构）
  const published = $app.findRecordsByFilter('trainings', "status = 'published'", '-start_time', 500, 0);
  const list = published.map(toBrief);
  // 本人有出席记录的 closed 培训（已关闭培训保留「我的签到状态」回看）
  const closed = $app.findRecordsByFilter('trainings', "status = 'closed'", '-start_time', 500, 0);
  closed.forEach((t) => {
    if (myByTraining[t.id]) list.push(toBrief(t));
  });

  return e.json(200, { eligible: true, trained: trained, trainings: list });
  } catch (err) {
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// 签到二维码 token：服务端为唯一生成方——创建时无条件覆盖为 24 位随机
// URL-safe token（$security 强随机，不可猜），调用方传入值一律忽略（防直连 API
// 自带可预测 token）；字段 required=false（迁移 1785889320），由本模型钩子兜底
// 实际非空（hooks 内创建路径同经此钩子）。同 activities.pb.js 加固做法。
// ---------------------------------------------------------------------------
onRecordCreate((e) => {
  const record = e.record;
  record.set('checkin_qr_token', $security.randomString(24));
  e.next();
}, 'trainings');
