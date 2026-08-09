// checkins.pb.js — 签到 hooks：场次开放/关闭、自助签到、补签、撤销
//
// 端点契约（technical-design §5.5、database-design §5.2.10/§5.2.11，统一端点契约）：
// - POST /api/cc/checkin/self { token }                参与者自助签到（按 checkin_qr_token 定位活动；幂等，重复扫码返回已有记录）
// - POST /api/cc/activities/{id}/checkin/open|close    管理员开放/关闭签到（可重复开放/关闭）
// - POST /api/cc/checkins/manual {activity_id, participant_id, reason}   管理员补签（原因必填）
// - GET  /api/cc/activities/{id}/checkin/manual-candidates               补签候选人名单（按用户名选择）
// - POST /api/cc/checkins/{id}/revoke {reason}         管理员撤销签到（原因必填）
//
// 关键规则：
// - 签到前置：登录 + 报名已通过 + 签到开放中（FR-CHK-003）；未签到不建行；
// - 每活动每人仅一条 valid 记录：SQLite 无法表达部分唯一，由事务内查重保证
//   （database-design §5.2.11，FR-CHK-004、AC-09/AC-20）；撤销行保留（PRD §4.5）；
// - 补签/撤销仅管理端，必须填 reason 并写审计（FR-CHK-005、AC-10）；
// - 实际参与人数口径 = status=valid 记录数（FR-CHK-006）。
// 机构隔离：管理端点忽略客户端机构参数，机构范围从登录管理员身份注入（FR-ORG-006）。
// ⚠️ 本文件为「handler 自包含」模式（PocketBase 0.28.4 实测约束）：
// JSVM 各 hooks 文件顶层声明在请求处理时不可见（无跨文件全局共享、无 ES module），
// 每个 handler 只能使用自身闭包内的标识符与 JSVM 内建全局（$app / ApiError / Record 等）。
// 各 handler 顶部的共享函数与 lib/*.pb.js 契约同源（由生成器按引用自动内联，勿手工改副本）。

// ---------------------------------------------------------------------------
// POST /api/cc/activities/{id}/checkin/open — 开放签到（FR-CHK-002；幂等：已开放返回现有场次）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activities/{id}/checkin/open', (e) => {
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
  // 活动状态校验：已下架/已归档一律拒绝；草稿活动不可开放签到
  const activityStatus = activity.get('status');
  if (activityStatus === 'taken_down' || activityStatus === 'archived' || activityStatus === 'draft') {
    ccError(400, 'ACTIVITY_NOT_OPEN', '活动当前状态不可开放签到');
  }

  let session = null;
  let created = false;
  $app.runInTransaction((txApp) => {
    // 同一活动同一时间至多一条 open 记录（事务保证，database-design §5.2.10）
    session = ccOne(txApp, 'checkin_sessions', "activity_id = {:a} && status = 'open'", { a: activity.id });
    if (session) return; // 幂等：已有开放中场次
    const collection = txApp.findCollectionByNameOrId('checkin_sessions');
    session = new Record(collection);
    session.set('activity_id', activity.id);
    session.set('status', 'open');
    session.set('opened_at', ccNow());
    session.set('opened_by', admin.id);
    txApp.save(session);
    created = true;
    // 审计：签到开放（security-privacy §8.1 签到类）
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'admin', organizationId: orgId,
      action: 'checkin_session.open', targetType: 'checkin_session', targetId: session.id,
      result: 'success', metadata: { activity_id: activity.id },
    });
  });

  return e.json(200, { session: session, created: created });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/activities/{id}/checkin/close — 关闭签到（FR-CHK-002；幂等：无开放场次为空操作）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activities/{id}/checkin/close', (e) => {
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

  let session = null;
  let closed = false;
  $app.runInTransaction((txApp) => {
    session = ccOne(txApp, 'checkin_sessions', "activity_id = {:a} && status = 'open'", { a: activity.id });
    if (!session) return; // 幂等：本就未开放
    session.set('status', 'closed');
    session.set('closed_at', ccNow());
    txApp.save(session);
    closed = true;
    // 审计：签到关闭（security-privacy §8.1 签到类）
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'admin', organizationId: orgId,
      action: 'checkin_session.close', targetType: 'checkin_session', targetId: session.id,
      result: 'success', metadata: { activity_id: activity.id },
    });
  });

  return e.json(200, { session: session, closed: closed });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/checkin/self — 参与者自助签到（FR-CHK-003/004、AC-09/AC-20）
// 入参 { token }：活动固定签到二维码 token（checkin_qr_token，FR-CHK-001），查无 404。
// 幂等：重复扫码返回已有有效签到，不报错不新建。
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/checkin/self', (e) => {
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
  const participant = requireAuth(e, 'participant');
  // 入参为签到二维码 token（二维码内容为 /checkin/<token> 落地链接，FR-CHK-001）；
  // body 类型校验（L1）：非字符串直接 400
  const body = e.requestInfo().body || {};
  const token = body.token;
  if (typeof token !== 'string' || token === '') {
    ccError(400, 'INVALID_TOKEN', '缺少有效的签到二维码 token');
  }
  const activity = ccOne($app, 'activities', 'checkin_qr_token = {:t}', { t: token });
  if (!activity) {
    ccError(404, 'ACTIVITY_NOT_FOUND', '活动不存在或签到二维码无效');
  }
  const activityId = activity.id;
  // 仅已发布/已关闭活动可签到（下架/归档/未发布不可，PRD §4.3）
  const status = activity.get('status');
  if (status !== 'published' && status !== 'closed') {
    ccError(400, 'CHECKIN_UNAVAILABLE', '活动当前不可签到');
  }

  // 报名状态与场次开放校验移入事务内（消除事务外 TOCTOU）；
  // SQLite 快照冲突/SQLITE_BUSY 类错误最多重试 2 次，仍失败返回 409 CONFLICT
  const isBusyErr = (err) => !!err && /busy|locked|snapshot/i.test(String((err && err.message) || err));
  let registration = null;
  let checkin = null;
  let created = false;
  let attempts = 0;
  for (;;) {
    try {
      $app.runInTransaction((txApp) => {
        // 签到前置：报名已通过（FR-CHK-003）；业务码小写与 participant 端展示分支契约一致
        registration = ccOne(
          txApp, 'registrations',
          'activity_id = {:a} && participant_id = {:p}',
          { a: activityId, p: participant.id },
        );
        if (!registration || registration.get('status') !== 'approved') {
          ccError(403, 'registration_not_approved', '报名未通过，不能签到');
        }

        // 幂等：已有有效签到直接返回（重复扫码/网络重试，AC-20）；
        // 每活动每人仅一条 valid（并发扫码兜底，AC-09）
        checkin = ccOne(
          txApp, 'checkins',
          "activity_id = {:a} && participant_id = {:p} && status = 'valid'",
          { a: activityId, p: participant.id },
        );
        if (checkin) return;

        // 签到开放中校验（FR-CHK-002）：无开放场次时区分「未开放」（从未开放过）
        // 与「已结束」（曾开放后关闭），前端按 checkin_not_open / checkin_closed 分开展示
        if (!ccOne(txApp, 'checkin_sessions', "activity_id = {:a} && status = 'open'", { a: activityId })) {
          const hadSession = ccOne(
            txApp, 'checkin_sessions', 'activity_id = {:a}', { a: activityId },
          );
          if (hadSession) {
            ccError(400, 'checkin_closed', '本场签到已结束');
          }
          ccError(400, 'checkin_not_open', '签到未开放');
        }

        const collection = txApp.findCollectionByNameOrId('checkins');
        checkin = new Record(collection);
        checkin.set('activity_id', activityId);
        checkin.set('participant_id', participant.id);
        checkin.set('registration_id', registration.id);
        checkin.set('source', 'self_scan');
        checkin.set('status', 'valid');
        checkin.set('checked_in_at', ccNow());
        checkin.set('operator_id', '');
        checkin.set('reason', '');
        txApp.save(checkin);
        created = true;
        // 审计：自助签到（security-privacy §8.1 签到类）
        writeAudit(txApp, {
          actorId: participant.id, actorRole: 'participant',
          organizationId: activity.get('organization_id'),
          action: 'checkin.self', targetType: 'checkin', targetId: checkin.id,
          result: 'success', metadata: { activity_id: activityId, source: 'self_scan' },
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

  return e.json(200, { checkin: checkin, already_checked_in: !created });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/checkins/manual — 管理员补签（FR-CHK-005、AC-10：原因必填 + 审计；幂等）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/checkins/manual', (e) => {
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
  const body = e.requestInfo().body || {};
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason === '') {
    ccError(400, 'REASON_REQUIRED', '补签必须填写原因');
  }
  const activity = ccById($app, 'activities', body.activity_id);
  if (!activity || activity.get('organization_id') !== orgId) {
    ccError(404, 'ACTIVITY_NOT_FOUND', '活动不存在');
  }
  const participantId = body.participant_id;
  if (typeof participantId !== 'string' || participantId === '') {
    ccError(400, 'INVALID_PARTICIPANT', '缺少 participant_id');
  }

  const registration = ccOne(
    $app, 'registrations',
    'activity_id = {:a} && participant_id = {:p}',
    { a: activity.id, p: participantId },
  );
  if (!registration || registration.get('status') !== 'approved') {
    ccError(400, 'registration_not_approved', '该参与者报名未通过，不能补签');
  }

  // 幂等：已有有效签到返回现有记录（AC-20）；补签不要求签到场次开放
  let checkin = ccOne(
    $app, 'checkins',
    "activity_id = {:a} && participant_id = {:p} && status = 'valid'",
    { a: activity.id, p: participantId },
  );
  if (checkin) {
    return e.json(200, { checkin: checkin, existing: true });
  }

  let created = false;
  $app.runInTransaction((txApp) => {
    checkin = ccOne(
      txApp, 'checkins',
      "activity_id = {:a} && participant_id = {:p} && status = 'valid'",
      { a: activity.id, p: participantId },
    );
    if (checkin) return;
    const collection = txApp.findCollectionByNameOrId('checkins');
    checkin = new Record(collection);
    checkin.set('activity_id', activity.id);
    checkin.set('participant_id', participantId);
    checkin.set('registration_id', registration.id);
    checkin.set('source', 'manual');
    checkin.set('status', 'valid');
    checkin.set('checked_in_at', ccNow());
    checkin.set('operator_id', admin.id);
    checkin.set('reason', reason);
    txApp.save(checkin);
    created = true;
    // 审计：补签（FR-CHK-005、AC-10），原因必填
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'admin', organizationId: orgId,
      action: 'checkin.manual', targetType: 'checkin', targetId: checkin.id,
      result: 'success', reason: reason,
      metadata: { activity_id: activity.id, participant_id: participantId },
    });
  });

  return e.json(200, { checkin: checkin, existing: !created });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /api/cc/activities/{id}/checkin/manual-candidates — 补签候选人名单
// 管理员不可读 participant_accounts 集合（listRule 关闭，无参与者名录），
// 补签下拉需要按用户名选择，故由服务端按本机构活动注入已通过报名的
// { participant_id, username } 名单（仅本机构活动，不暴露其他参与者信息）。
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/cc/activities/{id}/checkin/manual-candidates', (e) => {
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
  const admin = requireAuth(e, 'admin');
  const orgId = admin.get('organization_id');
  const activity = ccById($app, 'activities', e.request.pathValue('id'));
  if (!activity || activity.get('organization_id') !== orgId) {
    ccError(404, 'ACTIVITY_NOT_FOUND', '活动不存在');
  }

  const registrations = $app.findRecordsByFilter(
    'registrations', "activity_id = {:a} && status = 'approved'", '', 500, 0,
    { a: activity.id },
  );
  const candidates = [];
  registrations.forEach((reg) => {
    const participant = ccById($app, 'participant_accounts', reg.get('participant_id'));
    if (!participant) return; // 账号异常缺失时跳过，不阻断名单
    candidates.push({
      participant_id: participant.id,
      username: participant.get('username'),
      activity_role: reg.get('activity_role'),
    });
  });
  candidates.sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));

  return e.json(200, { candidates: candidates });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/checkins/{id}/revoke — 撤销签到（FR-CHK-005、AC-10：原因必填 + 审计；
// 只改状态不删行，原记录保留，PRD §4.5；幂等：已撤销返回原记录）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/checkins/{id}/revoke', (e) => {
  try {
  const ccIsNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
  const ccById = (app, collection, id) => {
    try { return app.findRecordById(collection, id); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  // 统一错误：抛出标记对象，由 handler 顶层 catch 转为统一 JSON 错误响应
  // （new ApiError 的第三参数会被当作字段错误映射转换，无法携带自定义 data，0.28.4 实测）
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const ccNow = () => new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
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
  const body = e.requestInfo().body || {};
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason === '') {
    ccError(400, 'REASON_REQUIRED', '撤销必须填写原因');
  }

  const checkinId = e.request.pathValue('id');
  const checkin = ccById($app, 'checkins', checkinId);
  if (!checkin) {
    ccError(404, 'CHECKIN_NOT_FOUND', '签到记录不存在');
  }
  // 机构隔离（经 activity 反查，PRD §9.2）
  const activity = ccById($app, 'activities', checkin.get('activity_id'));
  if (!activity || activity.get('organization_id') !== orgId) {
    ccError(404, 'CHECKIN_NOT_FOUND', '签到记录不存在');
  }

  if (checkin.get('status') === 'revoked') {
    return e.json(200, { checkin: checkin, already_revoked: true });
  }

  let fresh = null;
  $app.runInTransaction((txApp) => {
    fresh = txApp.findRecordById('checkins', checkinId);
    if (fresh.get('status') === 'revoked') return; // 并发撤销幂等
    fresh.set('status', 'revoked');
    fresh.set('revoked_at', ccNow());
    fresh.set('operator_id', admin.id);
    fresh.set('reason', reason);
    txApp.save(fresh);
    // 审计：撤销签到（FR-CHK-005、AC-10）
    writeAudit(txApp, {
      actorId: admin.id, actorRole: 'admin', organizationId: orgId,
      action: 'checkin.revoke', targetType: 'checkin', targetId: checkinId,
      result: 'success', reason: reason,
      metadata: {
        activity_id: fresh.get('activity_id'),
        participant_id: fresh.get('participant_id'),
        source: fresh.get('source'),
      },
    });
  });

  return e.json(200, { checkin: fresh, already_revoked: false });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

