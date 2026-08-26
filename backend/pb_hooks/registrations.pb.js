// registrations.pb.js — 报名提交与报名状态迁移 hooks
//
// 端点契约（technical-design §5.5、database-design §5.5/§5.6，统一端点契约）：
// - POST /api/cc/activities/{id}/register {activity_role, answers:[{field_def_id, value}]}
//     参与者报名；幂等：同一参与者同一活动已有报名则返回现有记录（FR-REG-003、AC-20）；
//     报名开放校验：活动已发布 + 手动开关开 + 起止时间内（FR-ACT-005）；
//     新报名名额口径：总名额满拒绝全部新报名、角色名额满拒绝该角色（FR-ACT-007）。
// - POST /api/cc/registrations/{id}/transition {to, reason?, activity_role?}
//     管理员审核/取消/回退/审核时改角色：
//     迁移矩阵白名单（表外一律拒绝）+ runInTransaction 事务名额硬校验（AC-08）
//     + 取消/回退 reason 强制（FR-REG-008）+ 审计（含前后状态）。
// 机构隔离：transition 忽略客户端机构参数，机构范围一律从登录管理员身份注入（FR-ORG-006）。
// ⚠️ 本文件为「handler 自包含」模式（PocketBase 0.28.4 实测约束）：
// JSVM 各 hooks 文件顶层声明在请求处理时不可见（无跨文件全局共享、无 ES module），
// 每个 handler 只能使用自身闭包内的标识符与 JSVM 内建全局（$app / ApiError / Record 等）。
// 各 handler 顶部的共享函数与 lib/*.pb.js 契约同源（由生成器按引用自动内联，勿手工改副本）。

// ---------------------------------------------------------------------------
// POST /api/cc/activities/{id}/register — 参与者报名（幂等，FR-REG-001~004、AC-20）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activities/{id}/register', (e) => {
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
  const ccOne = (app, collection, filter, params) => {
    try { return app.findFirstRecordByFilter(collection, filter, params || {}); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
  };
  const ccUniqueErr = (err) => !!err && typeof err.message === 'string' && /unique/i.test(err.message);
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
  const CC_ACTIVITY_ROLES = ['speaker', 'listener'];
  const participant = requireAuth(e, 'participant');
  const activityId = e.request.pathValue('id');
  const activity = ccById($app, 'activities', activityId);
  if (!activity) {
    ccError(404, 'ACTIVITY_NOT_FOUND', '活动不存在');
  }

  const body = e.requestInfo().body || {};

  // 幂等：重复进入/网络重试返回现有报名记录（FR-REG-003、AC-20）
  const existing = ccOne(
    $app, 'registrations',
    'activity_id = {:a} && participant_id = {:p}',
    { a: activityId, p: participant.id },
  );
  if (existing) {
    return e.json(200, { registration: existing, existing: true });
  }

  // 报名开放校验（FR-ACT-005）：已发布 + 手动开关 + 起止时间内 + 活动未结束
  if (activity.get('status') !== 'published' || !activity.get('registration_open')) {
    ccError(400, 'REGISTRATION_CLOSED', '报名未开放');
  }
  const now = ccNow();
  const regStart = String(activity.get('registration_start_at') || '');
  const regEnd = String(activity.get('registration_end_at') || '');
  if ((regStart && now < regStart) || (regEnd && now > regEnd)) {
    ccError(400, 'REGISTRATION_CLOSED', '报名未在开放时间内');
  }
  // 活动已结束（end_time 已过）不再接受报名：机构未手动关闭（仍 published）时也兜底，
  // 与公开列表/详情的 registration.open 口径一致（FR-ACT-005）
  const activityEnd = String(activity.get('end_time') || '');
  if (activityEnd && now > activityEnd) {
    ccError(400, 'REGISTRATION_CLOSED', '活动已结束，报名已截止');
  }

  // 角色校验（FR-REG-002：角色存于报名，不写入账号）
  const role = body.activity_role;
  if (CC_ACTIVITY_ROLES.indexOf(role) < 0) {
    ccError(400, 'INVALID_ROLE', '报名角色须为 speaker 或 listener');
  }

  // 新报名名额口径（FR-ACT-007）：总满拒全部、角色满拒该角色（硬校验在审核通过时事务内执行）
  if (ccApprovedCount($app, activityId, null) >= activity.get('capacity_total')) {
    ccError(409, 'CAPACITY_FULL', '活动名额已满，暂不接受新报名');
  }
  if (ccApprovedCount($app, activityId, role) >=
      (role === 'speaker' ? activity.get('capacity_speaker') : activity.get('capacity_listener'))) {
    ccError(409, 'ROLE_CAPACITY_FULL', '该角色名额已满');
  }

  // 报名字段答案校验（FR-REG-001；具体字段 PRD 未写死，D-1/D-3 能力层）：
  // 适用字段 = 平台标准字段（organization_id 为空）+ 本机构自定义字段，均须 active
  // 且 role_scope ∈ {both, 所报角色}（分角色报名问卷，迁移 1785889320；角色不适用字段
  // 提交答案报 field_not_applicable，必填检查也只针对适用字段）；
  // 活动级 activities.form_config_json = { fields: [{ field_def_id, enabled, required }] }
  // （数组版，与 admin 端 features/admin/lib/rules.ts 契约为准）可覆盖启用/必填，缺省按 required_default。
  const orgId = activity.get('organization_id');
  const defs = $app.findRecordsByFilter(
    'registration_field_defs',
    "(organization_id = '' || organization_id = {:org}) && status = 'active'",
    '', 5000, 0, { org: orgId },
  );
  // JSON 字段读出为 Go []byte（桥接为字节数组），统一 String 化后 JSON.parse（0.28.4 实测）
  const ccJson = (val, fallback) => {
    try { const v = JSON.parse(String(val == null ? '' : val)); return v == null ? fallback : v; } catch (err) { return fallback; }
  };
  // form_config 数组版解析：按 field_def_id 索引为 map；非法项忽略，整体非法回退空配置
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
  const defById = {};
  const enabledById = {}; // 全部启用字段（含角色不适用项，用于区分 field_not_applicable）
  for (const def of defs) {
    const cfg = fieldConfig[def.id] || {};
    if (cfg.enabled === false) continue; // 活动级停用
    const item = {
      def: def,
      required: cfg.required != null ? !!cfg.required : !!def.get('required_default'),
    };
    enabledById[def.id] = item;
    // 分角色报名问卷（role_scope）：仅 both 或与所报角色一致的字段参与校验；
    // 存量字段缺省按 both 归一（迁移 1785889320 已回填，此处防御性归一）
    const roleScope = def.get('role_scope') || 'both';
    if (roleScope !== 'both' && roleScope !== role) continue;
    defById[def.id] = item;
  }

  // 选项成员校验：options_json 约定为 [{value,label}] 或字符串数组（草案 D-1，可解析才校验）
  const assertChoiceMember = (def, values) => {
    const options = ccJson(def.get('options_json'), []);
    if (!Array.isArray(options) || options.length === 0) return;
    const allowed = options.map((o) => (typeof o === 'string' ? o : o && o.value));
    if (allowed.some((v) => typeof v !== 'string')) return;
    for (const v of values) {
      if (allowed.indexOf(v) < 0) {
        ccError(400, 'INVALID_VALUE', '字段 ' + def.get('field_code') + ' 含非法选项值');
      }
    }
  };
  // 按 field_type 校验答案值形态（能力层，字段内容 PRD 未写死，D-1）：
  // 文本 ≤2000 字符；数字须有限（拒 Infinity/NaN，防 JSON 落库劣化）；日期锚定整串
  const validateAnswerValue = (def, value) => {
    const type = def.get('field_type');
    const code = def.get('field_code');
    if (type === 'text') {
      if (typeof value !== 'string') ccError(400, 'INVALID_VALUE', '字段 ' + code + ' 须为文本');
      if (value.length > 2000) ccError(400, 'INVALID_VALUE', '字段 ' + code + ' 文本长度不可超过 2000 字符');
    } else if (type === 'number') {
      if (typeof value !== 'number' || !isFinite(value)) ccError(400, 'INVALID_VALUE', '字段 ' + code + ' 须为有限数字');
    } else if (type === 'single_choice') {
      if (typeof value !== 'string') ccError(400, 'INVALID_VALUE', '字段 ' + code + ' 须为单选值');
      assertChoiceMember(def, [value]);
    } else if (type === 'multi_choice') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        ccError(400, 'INVALID_VALUE', '字段 ' + code + ' 须为文本数组');
      }
      assertChoiceMember(def, value);
    } else if (type === 'date') {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        ccError(400, 'INVALID_VALUE', '字段 ' + code + ' 须为日期（YYYY-MM-DD）');
      }
    } else {
      ccError(400, 'INVALID_FIELD', '未知字段类型');
    }
  };

  const answers = Array.isArray(body.answers) ? body.answers : [];
  const seen = {};
  for (const ans of answers) {
    if (!ans || typeof ans !== 'object') ccError(400, 'INVALID_ANSWERS', '答案格式不正确');
    const item = defById[ans.field_def_id];
    if (!item) {
      // 字段存在且启用但不适用于当前报名角色（role_scope 不匹配）→ 单独业务码
      if (enabledById[ans.field_def_id]) {
        ccError(400, 'field_not_applicable', '字段不适用于当前报名角色：' + enabledById[ans.field_def_id].def.get('label'));
      }
      ccError(400, 'INVALID_FIELD', '报名字段不存在或未启用');
    }
    if (seen[ans.field_def_id]) ccError(400, 'DUPLICATE_FIELD', '同一字段重复提交');
    seen[ans.field_def_id] = true;
    validateAnswerValue(item.def, ans.value);
  }
  for (const defId in defById) {
    if (!defById[defId].required) continue;
    const ans = answers.find((a) => a && a.field_def_id === defId);
    if (!ans || ans.value == null || ans.value === '' ||
        (Array.isArray(ans.value) && ans.value.length === 0)) {
      ccError(400, 'REQUIRED_FIELD_MISSING', '存在未填写的必填项：' + defById[defId].def.get('label'));
    }
  }

  // 创建报名 + 答案（单事务；复合唯一索引兜底并发重复提交）
  let registration = null;
  try {
    $app.runInTransaction((txApp) => {
      const collection = txApp.findCollectionByNameOrId('registrations');
      registration = new Record(collection);
      registration.set('activity_id', activityId);
      registration.set('participant_id', participant.id);
      registration.set('activity_role', role);
      registration.set('status', 'pending');
      registration.set('submitted_at', ccNow());
      registration.set('status_reason', '');
      txApp.save(registration);

      const answerCol = txApp.findCollectionByNameOrId('registration_answers');
      for (const ans of answers) {
        if (ans.value == null || ans.value === '') continue; // 可空未答不落行
        const row = new Record(answerCol);
        row.set('registration_id', registration.id);
        row.set('field_def_id', ans.field_def_id);
        row.set('value_json', ans.value);
        txApp.save(row);
      }
    });
  } catch (err) {
    // 并发双提交：唯一索引兜底，返回先创建的记录（AC-20）
    if (ccUniqueErr(err)) {
      const dup = ccOne(
        $app, 'registrations', 'activity_id = {:a} && participant_id = {:p}',
        { a: activityId, p: participant.id },
      );
      if (dup) return e.json(200, { registration: dup, existing: true });
    }
    throw err;
  }

  return e.json(200, { registration: registration, existing: false });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/registrations/{id}/transition — 报名状态迁移（FR-REG-005/007/008、AC-07/08）
// 矩阵白名单 + 事务名额硬校验 + 取消/回退原因必填 + 审计（前后状态）。
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/registrations/{id}/transition', (e) => {
  try {
  // 统一错误：抛出标记对象，由 handler 顶层 catch 转为统一 JSON 错误响应
  // （new ApiError 的第三参数会被当作字段错误映射转换，无法携带自定义 data，0.28.4 实测）
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const ccCount = (app, collection, filter, params) => app.findRecordsByFilter(collection, filter, '', 5000, 0, params || {}).length;
  // 活动当前已通过计数（总/按角色）；事务内传 txApp 即同事务读
  const ccApprovedCount = (app, activityId, role) => role
    ? ccCount(app, 'registrations', "activity_id = {:a} && status = 'approved' && activity_role = {:r}", { a: activityId, r: role })
    : ccCount(app, 'registrations', "activity_id = {:a} && status = 'approved'", { a: activityId });
  // 名额硬校验（FR-ACT-006/007、AC-08）：总名额 + 目标角色名额；须在事务内调用
  const ccAssertCapacity = (app, activity, targetRole) => {
    if (ccApprovedCount(app, activity.id, null) >= activity.get('capacity_total')) {
      ccError(409, 'CAPACITY_FULL', '活动总名额已满，无法通过');
    }
    const roleCap = targetRole === 'speaker' ? activity.get('capacity_speaker') : activity.get('capacity_listener');
    if (ccApprovedCount(app, activity.id, targetRole) >= roleCap) {
      ccError(409, 'ROLE_CAPACITY_FULL', '该角色名额已满，无法通过');
    }
  };
  const ccIsNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
  const ccById = (app, collection, id) => {
    try { return app.findRecordById(collection, id); } catch (err) { if (ccIsNoRows(err)) return null; throw err; }
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
  // 报名状态迁移矩阵（PRD §4.4，白名单以外一律拒绝）：
  // 待审核→已通过/已拒绝；已通过→已取消；已拒绝→已通过；已取消→已通过。
  const CC_REGISTRATION_TRANSITIONS = {
    'pending>approved': { action: 'registration.approve', reasonRequired: false },
    'pending>rejected': { action: 'registration.reject', reasonRequired: false },
    'approved>cancelled': { action: 'registration.cancel', reasonRequired: true },
    'rejected>approved': { action: 'registration.status_revert', reasonRequired: true },
    'cancelled>approved': { action: 'registration.status_revert', reasonRequired: true },
  };
  const CC_ACTIVITY_ROLES = ['speaker', 'listener'];

  const admin = requireAuth(e, 'admin');
  const orgId = admin.get('organization_id');
  const registrationId = e.request.pathValue('id');

  const registration = ccById($app, 'registrations', registrationId);
  if (!registration) {
    ccError(404, 'REGISTRATION_NOT_FOUND', '报名记录不存在');
  }
  const activity = ccById($app, 'activities', registration.get('activity_id'));
  // 机构隔离：跨机构一律 404（不泄露存在性，FR-ORG-006、AC-03）
  if (!activity || activity.get('organization_id') !== orgId) {
    ccError(404, 'REGISTRATION_NOT_FOUND', '报名记录不存在');
  }

  const body = e.requestInfo().body || {};
  const from = registration.get('status');
  const to = body.to;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  // 幂等：已是目标状态（重复提交/重试）直接返回现状，不重复校验与审计（AC-20 精神）
  if (from === to) {
    return e.json(200, { registration: registration, already: true });
  }

  // 矩阵白名单（表外迁移一律拒绝，AC-07）
  const rule = CC_REGISTRATION_TRANSITIONS[from + '>' + to];
  if (!rule) {
    ccError(400, 'ILLEGAL_TRANSITION', '不允许从当前状态迁移到目标状态');
  }
  // 取消/回退原因必填（FR-REG-008）
  if (rule.reasonRequired && reason === '') {
    ccError(400, 'REASON_REQUIRED', '该操作必须填写原因');
  }

  // 审核时修改活动角色（FR-REG-005）：仅允许随「迁移到已通过」一并发生
  const newRole = body.activity_role;
  let targetRole = registration.get('activity_role');
  if (newRole != null && newRole !== '') {
    if (to !== 'approved') {
      ccError(400, 'ROLE_CHANGE_NOT_ALLOWED', '仅审核通过时可修改活动角色');
    }
    if (CC_ACTIVITY_ROLES.indexOf(newRole) < 0) {
      ccError(400, 'INVALID_ROLE', '报名角色须为 speaker 或 listener');
    }
    targetRole = newRole;
  }
  const roleChanged = to === 'approved' && targetRole !== registration.get('activity_role');

  // 活动状态校验：已下架/已归档活动不可再审核报名（approve/reject 一律拒绝）
  if ((to === 'approved' || to === 'rejected') &&
      (activity.get('status') === 'taken_down' || activity.get('status') === 'archived')) {
    ccError(400, 'ACTIVITY_UNAVAILABLE', '活动已下架或已归档，不能审核报名');
  }

  let fresh = null;
  // SQLite 快照冲突/SQLITE_BUSY 类错误最多重试 2 次，仍失败返回 409 CONFLICT（并发友好化）
  const isBusyErr = (err) => !!err && /busy|locked|snapshot/i.test(String((err && err.message) || err));
  let attempts = 0;
  for (;;) {
    try {
      $app.runInTransaction((txApp) => {
        // 事务内重读：防审核间状态漂移
        fresh = txApp.findRecordById('registrations', registrationId);
        if (fresh.get('status') === to && fresh.get('activity_role') === targetRole) {
          return; // 幂等：已是目标状态与角色（并发同目标操作）
        }
        if (fresh.get('status') !== from) {
          ccError(409, 'CONCURRENT_MODIFICATION', '报名状态已被其他操作变更，请刷新后重试');
        }
        // 名额事务硬校验：通过/回退/改角色共用（FR-REG-005、AC-08）
        if (to === 'approved') {
          const freshActivity = txApp.findRecordById('activities', activity.id);
          ccAssertCapacity(txApp, freshActivity, targetRole);
        }
        fresh.set('status', to);
        if (to === 'approved') {
          fresh.set('activity_role', targetRole);
        }
        fresh.set('status_reason', reason);
        txApp.save(fresh);

        // 审计：状态变更（FR-REG-008、security-privacy §8.1 报名类），与业务写同事务
        const meta = {
          from: from, to: to,
          activity_id: activity.id, participant_id: fresh.get('participant_id'),
        };
        writeAudit(txApp, {
          actorId: admin.id, actorRole: 'admin', organizationId: orgId,
          action: rule.action, targetType: 'registration', targetId: registrationId,
          result: 'success', reason: reason || undefined, metadata: meta,
        });
        // 审核时改角色单独留痕（security-privacy §8.1「角色修改」）
        if (roleChanged) {
          writeAudit(txApp, {
            actorId: admin.id, actorRole: 'admin', organizationId: orgId,
            action: 'registration.role_change', targetType: 'registration', targetId: registrationId,
            result: 'success', reason: reason || undefined,
            metadata: {
              from: from, to: to,
              activity_id: activity.id, participant_id: fresh.get('participant_id'),
              from_role: registration.get('activity_role'), to_role: targetRole,
            },
          });
        }
      });
      break;
    } catch (err) {
      if (err && err.__ccError === true) throw err; // 业务错误不重试，顶层统一转换
      if (isBusyErr(err) && attempts < 2) {
        attempts++;
        continue;
      }
      if (isBusyErr(err)) {
        ccError(409, 'CONFLICT', '审核操作冲突，请稍后重试');
      }
      throw err;
    }
  }

  return e.json(200, { registration: fresh });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

