// activities.pb.js — 活动公开详情与活动生命周期 hooks
//
// 端点契约（technical-design §5.5、database-design §5.5，统一端点契约）：
// - GET  /api/cc/public/activities/{id}                公开活动详情（未登录可看，FR-ACT-003；
//     仅 published/closed 可见，含报名开放状态（open + 未开放 reason）与剩余名额口径、
//     活动级生效报名字段 registration_fields（form_config_json 数组版解析）；下架后公开入口不可访问）
// - POST /api/cc/activities/{id}/submit-review|publish|close|archive   管理员生命周期操作
// - POST /api/cc/activities/{id}/approve|reject {reason}|unpublish     超管审批/驳回/下架
//     活动状态机（PRD §4.3）：draft →（机构开启审核时 pending_review →）published → closed → archived；
//     published → taken_down（仅超管）；pending_review → rejected → 修改后可重提。
//     批准/驳回/下架写 activity_approvals + 审计（下架不经过 activity_approvals，直接改状态 + 审计）。
// - onRecordUpdate(activities)：名额修改下限校验——capacity_* 不得低于当前已通过人数（FR-ACT-006）。
// 机构隔离：管理员端点忽略客户端机构参数，机构范围从登录管理员身份注入（FR-ORG-006）；
// 跨机构一律 404（不泄露存在性，AC-03）。
// ⚠️ 本文件为「handler 自包含」模式（PocketBase 0.28.4 实测约束）：
// JSVM 各 hooks 文件顶层声明在请求处理时不可见（无跨文件全局共享、无 ES module），
// 每个 handler 只能使用自身闭包内的标识符与 JSVM 内建全局（$app / ApiError / Record 等）。
// 各 handler 顶部的共享函数与 lib/*.pb.js 契约同源（由生成器按引用自动内联，勿手工改副本）。

// ---------------------------------------------------------------------------
// GET /api/cc/public/activities/{id} — 公开活动详情（FR-ACT-003）
// 无需登录；仅 published/closed 可见（其余一律 404，含下架/归档/草稿，PRD §4.3）。
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/cc/public/activities/{id}', (e) => {
  try {
  const ccCount = (app, collection, filter, params) => app.findRecordsByFilter(collection, filter, '', 5000, 0, params || {}).length;
  // 活动当前已通过计数（总/按角色）；事务内传 txApp 即同事务读
  const ccApprovedCount = (app, activityId, role) => role
    ? ccCount(app, 'registrations', "activity_id = {:a} && status = 'approved' && activity_role = {:r}", { a: activityId, r: role })
    : ccCount(app, 'registrations', "activity_id = {:a} && status = 'approved'", { a: activityId });
  const ccIsNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
  const ccById = (app, collection, id) => {
    try { return app.findRecordById(collection, id); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  // 统一错误：抛出标记对象，由 handler 顶层 catch 转为统一 JSON 错误响应
  // （new ApiError 的第三参数会被当作字段错误映射转换，无法携带自定义 data，0.28.4 实测）
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const ccNow = () => new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  const activity = ccById($app, 'activities', e.request.pathValue('id'));
  if (!activity) {
    ccError(404, 'ACTIVITY_NOT_FOUND', '活动不存在或未发布');
  }
  const status = activity.get('status');
  if (status !== 'published' && status !== 'closed') {
    ccError(404, 'ACTIVITY_NOT_FOUND', '活动不存在或未发布');
  }

  // 剩余名额口径（统一端点契约）：名额 - 当前已通过数
  const approvedTotal = ccApprovedCount($app, activity.id, null);
  const approvedSpeaker = ccApprovedCount($app, activity.id, 'speaker');
  const approvedListener = ccApprovedCount($app, activity.id, 'listener');
  const remainingTotal = Math.max(0, activity.get('capacity_total') - approvedTotal);
  const remainingSpeaker = Math.max(0, activity.get('capacity_speaker') - approvedSpeaker);
  const remainingListener = Math.max(0, activity.get('capacity_listener') - approvedListener);

  // 报名开放状态（FR-ACT-005/007）：已发布 + 手动开关开 + 起止时间内 + 总名额未满
  const now = ccNow();
  const regStart = String(activity.get('registration_start_at') || '');
  const regEnd = String(activity.get('registration_end_at') || '');
  const withinWindow = (!regStart || now >= regStart) && (!regEnd || now <= regEnd);
  const accepting = status === 'published' && !!activity.get('registration_open') &&
    withinWindow && approvedTotal < activity.get('capacity_total');

  // 报名表字段（FR-REG-001 能力层，D-1/D-3）：标准字段 + 本机构自定义字段（active），
  // 应用活动级 form_config_json 覆盖；参与者无法直接查字段定义表，随公开详情下发。
  const defs = $app.findRecordsByFilter(
    'registration_field_defs',
    "(organization_id = '' || organization_id = {:org}) && status = 'active'",
    '', 5000, 0, { org: activity.get('organization_id') },
  );
  // JSON 字段读出为 Go []byte，统一 String 化后 JSON.parse（0.28.4 实测）
  const ccJson = (val, fallback) => {
    try { const v = JSON.parse(String(val == null ? '' : val)); return v == null ? fallback : v; } catch (err) { return fallback; }
  };
  // form_config 数组版（与 admin 端 features/admin/lib/rules.ts 契约为准）：
  // { fields: [{ field_def_id, enabled, required }] }，按 field_def_id 索引为 map
  const ccFormFieldMap = (raw) => {
    const cfg = ccJson(raw, {});
    const list = cfg && Array.isArray(cfg.fields) ? cfg.fields : [];
    const map = {};
    for (const f of list) {
      if (f && typeof f.field_def_id === 'string') map[f.field_def_id] = f;
    }
    return map;
  };
  const fieldConfig = ccFormFieldMap(activity.get('form_config_json'));
  const formFields = [];
  for (const def of defs) {
    const cfg = fieldConfig[def.id] || {};
    if (cfg.enabled === false) continue;
    formFields.push({
      id: def.id,
      field_code: def.get('field_code'),
      field_type: def.get('field_type'),
      label: def.get('label'),
      source_type: def.get('source_type'),
      is_sensitive: !!def.get('is_sensitive'),
      required: cfg.required != null ? !!cfg.required : !!def.get('required_default'),
      options_json: ccJson(def.get('options_json'), null),
    });
  }

  // 报名开放状态与未开放原因（参与者端分因展示，FR-ACT-005/007）：
  // closed=活动已关闭或手动开关关闭；not_started=未到报名开始；ended=已过截止；full=总名额已满
  let closedReason = null;
  if (status !== 'published' || !activity.get('registration_open')) closedReason = 'closed';
  else if (regStart && now < regStart) closedReason = 'not_started';
  else if (regEnd && now > regEnd) closedReason = 'ended';
  else if (approvedTotal >= activity.get('capacity_total')) closedReason = 'full';

  return e.json(200, {
    activity: {
      id: activity.id,
      title: activity.get('title'),
      activity_code: activity.get('activity_code'),
      description: activity.get('description'),
      location: activity.get('location'),
      start_time: activity.get('start_time'),
      end_time: activity.get('end_time'),
      status: status,
      capacity_total: activity.get('capacity_total'),
      capacity_speaker: activity.get('capacity_speaker'),
      capacity_listener: activity.get('capacity_listener'),
    },
    registration: {
      open: accepting,
      reason: accepting ? null : closedReason,
      remaining_total: remainingTotal,
      remaining_speaker: remainingSpeaker,
      remaining_listener: remainingListener,
    },
    registration_fields: formFields,
  });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/activities/{id}/submit-review — 提交平台审核（FR-ACT-004，机构开启审核时）
// draft|rejected → pending_review；写 activity_approvals(submit) + 审计
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activities/{id}/submit-review', (e) => {
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
  const activity = ccById($app, 'activities', e.request.pathValue('id'));
  if (!activity || activity.get('organization_id') !== orgId) {
    ccError(404, 'ACTIVITY_NOT_FOUND', '活动不存在');
  }
  // 机构未开启发布审核时应直接发布（FR-ORG-004）
  const orgRecord = $app.findRecordById('organizations', orgId);
  if (!orgRecord.get('require_activity_approval')) {
    ccError(400, 'APPROVAL_NOT_REQUIRED', '本机构无需平台审核，可直接发布');
  }
  const status = activity.get('status');
  if (status === 'pending_review') {
    return e.json(200, { activity: activity, already: true });
  }
  if (status !== 'draft' && status !== 'rejected') {
    ccError(400, 'ILLEGAL_TRANSITION', '仅草稿或已驳回状态可提交审核');
  }

  $app.runInTransaction((txApp) => {
    const fresh = txApp.findRecordById('activities', activity.id);
    if (fresh.get('status') === 'pending_review') return;
    if (fresh.get('status') !== 'draft' && fresh.get('status') !== 'rejected') {
      ccError(409, 'CONCURRENT_MODIFICATION', '活动状态已被变更，请刷新后重试');
    }
    const fromStatus = fresh.get('status');
    fresh.set('status', 'pending_review');
    txApp.save(fresh);
    // 提交动作写 activity_approvals(submit) + 审计
    const col = txApp.findCollectionByNameOrId('activity_approvals');
    const row = new Record(col);
    row.set('activity_id', fresh.id);
    row.set('reviewer_id', admin.id);
    row.set('action', 'submit');
    row.set('reason', '');
    txApp.save(row);
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'admin', organizationId: orgId,
      action: 'activity.submit_review', targetType: 'activity', targetId: fresh.id,
      result: 'success', metadata: { from: fromStatus, to: 'pending_review' },
    });
  });

  return e.json(200, { activity: $app.findRecordById('activities', activity.id), already: false });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/activities/{id}/publish — 直接发布（FR-ACT-004，机构未开启审核时）
// draft → published
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activities/{id}/publish', (e) => {
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
  const activity = ccById($app, 'activities', e.request.pathValue('id'));
  if (!activity || activity.get('organization_id') !== orgId) {
    ccError(404, 'ACTIVITY_NOT_FOUND', '活动不存在');
  }
  // 机构开启发布审核时禁止直发（FR-ORG-004、AC-04）
  const orgRecord = $app.findRecordById('organizations', orgId);
  if (orgRecord.get('require_activity_approval')) {
    ccError(400, 'APPROVAL_REQUIRED', '本机构活动发布需平台审核，请先提交审核');
  }
  if (activity.get('status') === 'published') {
    return e.json(200, { activity: activity, already: true });
  }
  if (activity.get('status') !== 'draft') {
    ccError(400, 'ILLEGAL_TRANSITION', '仅草稿状态可直接发布');
  }

  $app.runInTransaction((txApp) => {
    const fresh = txApp.findRecordById('activities', activity.id);
    if (fresh.get('status') === 'published') return;
    if (fresh.get('status') !== 'draft') {
      ccError(409, 'CONCURRENT_MODIFICATION', '活动状态已被变更，请刷新后重试');
    }
    const fromStatus = fresh.get('status');
    fresh.set('status', 'published');
    txApp.save(fresh);
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'admin', organizationId: orgId,
      action: 'activity.publish', targetType: 'activity', targetId: fresh.id,
      result: 'success', metadata: { from: fromStatus, to: 'published' },
    });
  });

  return e.json(200, { activity: $app.findRecordById('activities', activity.id), already: false });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/activities/{id}/close — 关闭活动（published → closed）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activities/{id}/close', (e) => {
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
  const activity = ccById($app, 'activities', e.request.pathValue('id'));
  if (!activity || activity.get('organization_id') !== orgId) {
    ccError(404, 'ACTIVITY_NOT_FOUND', '活动不存在');
  }
  if (activity.get('status') === 'closed') {
    return e.json(200, { activity: activity, already: true });
  }
  if (activity.get('status') !== 'published') {
    ccError(400, 'ILLEGAL_TRANSITION', '仅已发布活动可关闭');
  }

  $app.runInTransaction((txApp) => {
    const fresh = txApp.findRecordById('activities', activity.id);
    if (fresh.get('status') === 'closed') return;
    if (fresh.get('status') !== 'published') {
      ccError(409, 'CONCURRENT_MODIFICATION', '活动状态已被变更，请刷新后重试');
    }
    const fromStatus = fresh.get('status');
    fresh.set('status', 'closed');
    txApp.save(fresh);
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'admin', organizationId: orgId,
      action: 'activity.close', targetType: 'activity', targetId: fresh.id,
      result: 'success', metadata: { from: fromStatus, to: 'closed' },
    });
  });

  return e.json(200, { activity: $app.findRecordById('activities', activity.id), already: false });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/activities/{id}/archive — 归档活动（closed → archived）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activities/{id}/archive', (e) => {
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
  const activity = ccById($app, 'activities', e.request.pathValue('id'));
  if (!activity || activity.get('organization_id') !== orgId) {
    ccError(404, 'ACTIVITY_NOT_FOUND', '活动不存在');
  }
  if (activity.get('status') === 'archived') {
    return e.json(200, { activity: activity, already: true });
  }
  if (activity.get('status') !== 'closed') {
    ccError(400, 'ILLEGAL_TRANSITION', '仅已关闭活动可归档');
  }

  $app.runInTransaction((txApp) => {
    const fresh = txApp.findRecordById('activities', activity.id);
    if (fresh.get('status') === 'archived') return;
    if (fresh.get('status') !== 'closed') {
      ccError(409, 'CONCURRENT_MODIFICATION', '活动状态已被变更，请刷新后重试');
    }
    const fromStatus = fresh.get('status');
    fresh.set('status', 'archived');
    txApp.save(fresh);
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'admin', organizationId: orgId,
      action: 'activity.archive', targetType: 'activity', targetId: fresh.id,
      result: 'success', metadata: { from: fromStatus, to: 'archived' },
    });
  });

  return e.json(200, { activity: $app.findRecordById('activities', activity.id), already: false });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/activities/{id}/approve — 超管批准发布（pending_review → published）
// 写 activity_approvals(approve) + 审计（FR-ACT-004）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activities/{id}/approve', (e) => {
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
  const admin = requireAuth(e, 'super');
  const activity = ccById($app, 'activities', e.request.pathValue('id'));
  if (!activity) {
    ccError(404, 'ACTIVITY_NOT_FOUND', '活动不存在');
  }
  if (activity.get('status') === 'published') {
    return e.json(200, { activity: activity, already: true });
  }
  if (activity.get('status') !== 'pending_review') {
    ccError(400, 'ILLEGAL_TRANSITION', '仅待平台审核活动可批准');
  }

  $app.runInTransaction((txApp) => {
    const fresh = txApp.findRecordById('activities', activity.id);
    if (fresh.get('status') === 'published') return;
    if (fresh.get('status') !== 'pending_review') {
      ccError(409, 'CONCURRENT_MODIFICATION', '活动状态已被变更，请刷新后重试');
    }
    const fromStatus = fresh.get('status');
    fresh.set('status', 'published');
    txApp.save(fresh);
    const col = txApp.findCollectionByNameOrId('activity_approvals');
    const row = new Record(col);
    row.set('activity_id', fresh.id);
    row.set('reviewer_id', admin.id);
    row.set('action', 'approve');
    row.set('reason', '');
    txApp.save(row);
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'super_admin',
      organizationId: fresh.get('organization_id'),
      action: 'activity.approve', targetType: 'activity', targetId: fresh.id,
      result: 'success', metadata: { from: fromStatus, to: 'published' },
    });
  });

  return e.json(200, { activity: $app.findRecordById('activities', activity.id), already: false });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/activities/{id}/reject — 超管驳回（pending_review → rejected，原因必填）
// 写 activity_approvals(reject, reason) + 审计（FR-ACT-004、PRD §4.3）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activities/{id}/reject', (e) => {
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
  const admin = requireAuth(e, 'super');
  const activity = ccById($app, 'activities', e.request.pathValue('id'));
  if (!activity) {
    ccError(404, 'ACTIVITY_NOT_FOUND', '活动不存在');
  }
  const body = e.requestInfo().body || {};
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason === '') {
    ccError(400, 'REASON_REQUIRED', '驳回必须填写原因');
  }
  if (activity.get('status') !== 'pending_review') {
    ccError(400, 'ILLEGAL_TRANSITION', '仅待平台审核活动可驳回');
  }

  $app.runInTransaction((txApp) => {
    const fresh = txApp.findRecordById('activities', activity.id);
    if (fresh.get('status') !== 'pending_review') {
      ccError(409, 'CONCURRENT_MODIFICATION', '活动状态已被变更，请刷新后重试');
    }
    const fromStatus = fresh.get('status');
    fresh.set('status', 'rejected');
    txApp.save(fresh);
    const col = txApp.findCollectionByNameOrId('activity_approvals');
    const row = new Record(col);
    row.set('activity_id', fresh.id);
    row.set('reviewer_id', admin.id);
    row.set('action', 'reject');
    row.set('reason', reason);
    txApp.save(row);
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'super_admin',
      organizationId: fresh.get('organization_id'),
      action: 'activity.reject', targetType: 'activity', targetId: fresh.id,
      result: 'success', reason: reason,
      metadata: { from: fromStatus, to: 'rejected' },
    });
  });

  return e.json(200, { activity: $app.findRecordById('activities', activity.id) });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/activities/{id}/unpublish — 超管下架（published → taken_down）
// 下架不经过 activity_approvals：直接改状态 + 审计（database-design §5.2.6）；
// 下架后公开入口不可访问（PRD §4.3，公开详情端点只对 published/closed 放行）。
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activities/{id}/unpublish', (e) => {
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
  const admin = requireAuth(e, 'super');
  const activity = ccById($app, 'activities', e.request.pathValue('id'));
  if (!activity) {
    ccError(404, 'ACTIVITY_NOT_FOUND', '活动不存在');
  }
  const body = e.requestInfo().body || {};
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (activity.get('status') === 'taken_down') {
    return e.json(200, { activity: activity, already: true });
  }
  if (activity.get('status') !== 'published') {
    ccError(400, 'ILLEGAL_TRANSITION', '仅已发布活动可下架');
  }

  $app.runInTransaction((txApp) => {
    const fresh = txApp.findRecordById('activities', activity.id);
    if (fresh.get('status') === 'taken_down') return;
    if (fresh.get('status') !== 'published') {
      ccError(409, 'CONCURRENT_MODIFICATION', '活动状态已被变更，请刷新后重试');
    }
    fresh.set('status', 'taken_down');
    txApp.save(fresh);
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'super_admin',
      organizationId: fresh.get('organization_id'),
      action: 'activity.unpublish', targetType: 'activity', targetId: fresh.id,
      result: 'success', reason: reason || undefined,
      metadata: { from: 'published', to: 'taken_down' },
    });
  });

  return e.json(200, { activity: $app.findRecordById('activities', activity.id), already: false });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// 名额修改下限校验（FR-ACT-006、AC-08）：capacity_* 不得低于当前已通过人数。
// 挂在 activities 模型更新钩子上，API 更新与程序化更新一视同仁；
// 生命周期端点只改状态不动名额，天然通过。
// ---------------------------------------------------------------------------
onRecordUpdate((e) => {
  const ccCount = (app, collection, filter, params) => app.findRecordsByFilter(collection, filter, '', 5000, 0, params || {}).length;
  // 活动当前已通过计数（总/按角色）；事务内传 txApp 即同事务读
  const ccApprovedCount = (app, activityId, role) => role
    ? ccCount(app, 'registrations', "activity_id = {:a} && status = 'approved' && activity_role = {:r}", { a: activityId, r: role })
    : ccCount(app, 'registrations', "activity_id = {:a} && status = 'approved'", { a: activityId });
  const record = e.record;
  const original = record.original();
  if (original && original.id) {
    const checks = [
      ['capacity_total', null],
      ['capacity_speaker', 'speaker'],
      ['capacity_listener', 'listener'],
    ];
    for (const pair of checks) {
      const field = pair[0];
      const role = pair[1];
      const newVal = record.get(field);
      if (newVal === original.get(field)) continue;
      const approved = ccApprovedCount(e.app, record.id, role);
      if (newVal < approved) {
        // 模型钩子内抛 ApiError（消息可读；第三参数 data 会被转换，不携带）
        throw new ApiError(400, '名额不可低于当前已通过人数（' + field + ' 当前已通过 ' + approved + ' 人）');
      }
    }
  }
  e.next();
}, 'activities');
