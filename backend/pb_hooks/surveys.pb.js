// Chat Circles — surveys.pb.js：问卷域 hooks（后端 B）
// 职责（technical-design §5.5、PRD §8.2/§8.3、FR-SUR-001/002/004/006/011）：
// - POST /api/cc/activities/{id}/surveys：从模板版本复制活动问卷，题目物化到 survey_questions；
//   复制后模板升级不影响已有问卷（FR-SUR-011、AC-13）。
// - POST /api/cc/activity-surveys/{id}/open|close：管理员手动开放/结束问卷
//   （开放中 open / 已结束 ended，PRD §8.2「管理员可分别开放和结束」），写审计
//   （security-privacy §8.1 问卷类：活动问卷开放/结束）。
// - GET /api/cc/surveys/{qrToken}：问卷元信息 + 资格四条件校验结果
//   （登录 / 报名已通过 / 角色匹配 / 开放中，FR-SUR-006）。
//   响应与 participant 端 SurveyMeta 契约一致：{ survey（含 activity_id）, activity,
//   questions, eligible, reasons, my_submission（含 submitted_at）, my_answers? }；
//   题目在资格全过或本人已有答卷（草稿预填/只读回看）时下发，答案元素 { question_code, value }。
// - survey_questions 编辑守卫：locked=true 锁定题禁改（FR-SUR-001）；机构仅可新增/编辑
//   自定义题（FR-SUR-002），question_code 不可变更（PRD §8.3 稳定机器字段）。
// - activity_surveys 直连守卫：创建与状态变更必须走上述端点（唯一服务端强制点，
//   technical-design §5.5「每条业务不变量都有唯一的服务端强制点」）。
//
// 模板版本 schema_json 题目契约（PRD §16.2 D-2：模板题目内容未写死，以下为能力层约定，
// 兼容 options/options_json、order/order_index、validation/validation_json 两种命名）：
// schema_json = { questions: [{ question_code, question_type, title, required,
//   options_json|options, locked, is_sensitive, order_index|order, validation_json|validation }] }
//
// 实现注意（PocketBase 0.28 JSVM 实测）：路由/守卫 handler 在请求期以全新作用域执行，
// 文件级函数/常量对 handler 不可见，故每个 handler 自包含、共享 lib 在 handler 内 require。
// 另实测：json 字段 record.get() 返回原始 JSON 字节数组（非解析后对象），读取处需自行解码。

// ---------------------------------------------------------------------------
// 端点 1：POST /api/cc/activities/{id}/surveys — 从模板版本复制活动问卷
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activities/{id}/surveys', (e) => {
    // --- 内联共享 lib（JSVM 各 hooks 文件作用域完全隔离，lib 为「标准源」契约须内联使用，
  //     与 lib/http.pb.js 同实现；见 lib/audit.pb.js 顶部集成说明）---
  const jsonError = (e, status, code, message) => e.json(status, { code: status, message, data: { code } });
  // 统一错误：抛出标记对象，由 handler 顶层 catch 转为统一 JSON 错误响应
  // （new ApiError 的第三参数会被当作字段错误映射转换，无法携带自定义 data，0.28.4 实测）
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
      // 机构停用后其管理员不能进入业务后台（FR-ORG-001），历史数据保留
      let org = null;
      try {
        org = e.app.findRecordById('organizations', auth.get('organization_id'));
      } catch (_) {
        org = null;
      }
      if (!org || org.get('status') !== 'active') ccError(403, 'ORG_DISABLED', '所属机构已停用');
      return auth;
    }
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };

  // json 字段读取解码（JSVM 返回原始 JSON 字节数组）：字符串/字节数组 → 解析后对象
  const decodeJson = (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch (_) {
        return v;
      }
    }
    if (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'number')) {
      let s = '';
      let i = 0;
      while (i < v.length) {
        const b = v[i];
        if (b < 0x80) {
          s += String.fromCharCode(b);
          i += 1;
        } else if (b < 0xe0) {
          s += String.fromCharCode(((b & 0x1f) << 6) | (v[i + 1] & 0x3f));
          i += 2;
        } else if (b < 0xf0) {
          s += String.fromCharCode(((b & 0x0f) << 12) | ((v[i + 1] & 0x3f) << 6) | (v[i + 2] & 0x3f));
          i += 3;
        } else {
          let cp = ((b & 0x07) << 18) | ((v[i + 1] & 0x3f) << 12) | ((v[i + 2] & 0x3f) << 6) | (v[i + 3] & 0x3f);
          cp -= 0x10000;
          s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
          i += 4;
        }
      }
      try {
        return JSON.parse(s);
      } catch (_) {
        return v;
      }
    }
    return v;
  };

  let auth;
  try {
    auth = requireAuth(e, 'admin');
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }

  let activity;
  try {
    activity = $app.findRecordById('activities', e.request.pathValue('id'));
  } catch (_) {
    return jsonError(e, 404, 'not_found', '活动不存在');
  }
  if (activity.get('organization_id') !== auth.get('organization_id')) {
    return jsonError(e, 403, 'forbidden', '无权操作其他机构的活动');
  }

  const body = e.requestInfo().body || {};
  const phase = body.phase || 'onsite';
  if (['before', 'onsite', 'after'].indexOf(phase) < 0) return jsonError(e, 400, 'validation_failed', '问卷阶段无效');
  const plannedOpen = body.planned_open_at || '';
  if (plannedOpen && (typeof plannedOpen !== 'string' || !Number.isFinite(Date.parse(plannedOpen)))) return jsonError(e, 400, 'validation_failed', '预计开放时间无效');
  const roleScope = body.role_scope;
  if (['speaker', 'listener', 'both'].indexOf(roleScope) < 0) {
    return jsonError(e, 400, 'validation_failed', 'role_scope 必须为 speaker / listener / both');
  }
  const title = (body.title || '').trim();
  if (!title) {
    return jsonError(e, 400, 'validation_failed', 'title 必填');
  }
  let version;
  try {
    version = $app.findRecordById('survey_template_versions', body.template_version_id);
  } catch (_) {
    return jsonError(e, 400, 'validation_failed', 'template_version_id 无效');
  }

  // 模板题目快照（复制物化，之后模板升级不影响本问卷，FR-SUR-011、AC-13）
  const schema = decodeJson(version.get('schema_json')) || {};
  const tplQuestions = Array.isArray(schema.questions) ? schema.questions : [];

  // 生成活动内唯一 survey_code：活动代码 + _S 序号（PRD 附录 B 可读稳定代码）
  const baseCode = activity.get('activity_code') + '_S';
  let surveyCode = '';
  for (let i = 1; i < 100; i++) {
    const candidate = baseCode + String(i).padStart(2, '0');
    try {
      $app.findFirstRecordByFilter('activity_surveys', 'survey_code = {:c}', { c: candidate });
    } catch (_) {
      surveyCode = candidate;
      break;
    }
  }
  if (!surveyCode) {
    return jsonError(e, 500, 'internal_error', '无法分配 survey_code');
  }

  const qrToken = $security.randomString(24); // 不可连续可猜（PRD §10.3 同类要求）
  let created;
  try {
    $app.runInTransaction((txApp) => {
      const surveysCol = txApp.findCollectionByNameOrId('activity_surveys');
      const questionsCol = txApp.findCollectionByNameOrId('survey_questions');

      const survey = new Record(surveysCol);
      survey.set('activity_id', activity.id);
      survey.set('template_version_id', version.id);
      survey.set('survey_code', surveyCode);
      survey.set('title', title);
      survey.set('role_scope', roleScope);
      survey.set('phase', phase);
      survey.set('planned_open_at', plannedOpen);
      survey.set('status', 'draft');
      survey.set('qr_token', qrToken);
      txApp.save(survey);

      tplQuestions.forEach((tq, idx) => {
        const q = new Record(questionsCol);
        q.set('activity_survey_id', survey.id);
        q.set('question_code', tq.question_code);
        q.set('source_type', 'standard');
        q.set('question_type', tq.question_type);
        q.set('title', tq.title || '');
        q.set('required', !!tq.required);
        q.set('options_json', tq.options_json !== undefined ? tq.options_json : tq.options || null);
        q.set('locked', !!tq.locked);
        q.set('is_sensitive', !!tq.is_sensitive);
        // PB 实测：required number 字段把 0 视为空值拒绝，统一 +1 存储（只保相对顺序）
        const orderVal = tq.order_index !== undefined ? tq.order_index : tq.order !== undefined ? tq.order : idx;
        q.set('order_index', orderVal + 1);
        q.set('validation_json', tq.validation_json !== undefined ? tq.validation_json : tq.validation || null);
        txApp.save(q);
      });

      created = survey;
    });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    // 内部错误细节不回传客户端（仅服务端日志可读）
    return jsonError(e, 500, 'internal_error', '复制活动问卷失败，请稍后重试');
  }

  return e.json(200, {
    survey: {
      id: created.id,
      activity_id: created.get('activity_id'),
      template_version_id: created.get('template_version_id'),
      survey_code: created.get('survey_code'),
      title: created.get('title'),
      role_scope: created.get('role_scope'),
      phase: created.get('phase'),
      planned_open_at: String(created.get('planned_open_at') || ''),
      status: created.get('status'),
      qr_token: created.get('qr_token'),
    },
    questions_copied: tplQuestions.length,
  });
});

// ---------------------------------------------------------------------------
// 端点 2：POST /api/cc/activity-surveys/{id}/open|close — 开放 / 结束问卷
// 状态机（PRD §8.2）：draft / not_open → open（开放中）；open → ended（已结束）。
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activity-surveys/{id}/open', (e) => {
    const writeAudit = (app, entry) => {
    // 与 lib/audit.pb.js 同实现（内联，原因同上）
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
    // --- 内联共享 lib（JSVM 各 hooks 文件作用域完全隔离，lib 为「标准源」契约须内联使用，
  //     与 lib/http.pb.js 同实现；见 lib/audit.pb.js 顶部集成说明）---
  const jsonError = (e, status, code, message) => e.json(status, { code: status, message, data: { code } });
  // 统一错误：抛出标记对象，由 handler 顶层 catch 转为统一 JSON 错误响应
  // （new ApiError 的第三参数会被当作字段错误映射转换，无法携带自定义 data，0.28.4 实测）
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
      // 机构停用后其管理员不能进入业务后台（FR-ORG-001），历史数据保留
      let org = null;
      try {
        org = e.app.findRecordById('organizations', auth.get('organization_id'));
      } catch (_) {
        org = null;
      }
      if (!org || org.get('status') !== 'active') ccError(403, 'ORG_DISABLED', '所属机构已停用');
      return auth;
    }
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };

  let auth;
  try {
    auth = requireAuth(e, 'admin');
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
  let survey;
  try {
    survey = $app.findRecordById('activity_surveys', e.request.pathValue('id'));
  } catch (_) {
    return jsonError(e, 404, 'not_found', '活动问卷不存在');
  }
  const activity = $app.findRecordById('activities', survey.get('activity_id'));
  if (activity.get('organization_id') !== auth.get('organization_id')) {
    return jsonError(e, 403, 'forbidden', '无权操作其他机构的问卷');
  }
  const from = survey.get('status');
  if (['draft', 'not_open'].indexOf(from) < 0) {
    return jsonError(e, 400, 'invalid_transition', '仅草稿/未开放状态可开放，当前状态：' + from);
  }
  // 业务写 + 审计同事务提交（状态变更与留痕不可分）
  $app.runInTransaction((txApp) => {
    survey.set('status', 'open');
    if (!survey.get('opened_at')) {
      survey.set('opened_at', new Date().toISOString());
    }
    txApp.save(survey);
    writeAudit(txApp, {
      actorId: auth.id,
      actorRole: 'admin',
      organizationId: auth.get('organization_id'),
      action: 'survey.open',
      targetType: 'activity_survey',
      targetId: survey.id,
      result: 'success',
      metadata: { from, to: 'open', survey_code: survey.get('survey_code') },
    });
  });
  return e.json(200, { id: survey.id, status: 'open' });
});

routerAdd('POST', '/api/cc/activity-surveys/{id}/close', (e) => {
    const writeAudit = (app, entry) => {
    // 与 lib/audit.pb.js 同实现（内联，原因同上）
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
    // --- 内联共享 lib（JSVM 各 hooks 文件作用域完全隔离，lib 为「标准源」契约须内联使用，
  //     与 lib/http.pb.js 同实现；见 lib/audit.pb.js 顶部集成说明）---
  const jsonError = (e, status, code, message) => e.json(status, { code: status, message, data: { code } });
  // 统一错误：抛出标记对象，由 handler 顶层 catch 转为统一 JSON 错误响应
  // （new ApiError 的第三参数会被当作字段错误映射转换，无法携带自定义 data，0.28.4 实测）
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
      // 机构停用后其管理员不能进入业务后台（FR-ORG-001），历史数据保留
      let org = null;
      try {
        org = e.app.findRecordById('organizations', auth.get('organization_id'));
      } catch (_) {
        org = null;
      }
      if (!org || org.get('status') !== 'active') ccError(403, 'ORG_DISABLED', '所属机构已停用');
      return auth;
    }
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };

  let auth;
  try {
    auth = requireAuth(e, 'admin');
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
  let survey;
  try {
    survey = $app.findRecordById('activity_surveys', e.request.pathValue('id'));
  } catch (_) {
    return jsonError(e, 404, 'not_found', '活动问卷不存在');
  }
  const activity = $app.findRecordById('activities', survey.get('activity_id'));
  if (activity.get('organization_id') !== auth.get('organization_id')) {
    return jsonError(e, 403, 'forbidden', '无权操作其他机构的问卷');
  }
  const from = survey.get('status');
  if (from !== 'open') {
    return jsonError(e, 400, 'invalid_transition', '仅开放中的问卷可结束，当前状态：' + from);
  }
  // 业务写 + 审计同事务提交（状态变更与留痕不可分）
  $app.runInTransaction((txApp) => {
    survey.set('status', 'ended');
    survey.set('ended_at', new Date().toISOString());
    txApp.save(survey);
    writeAudit(txApp, {
      actorId: auth.id,
      actorRole: 'admin',
      organizationId: auth.get('organization_id'),
      action: 'survey.close',
      targetType: 'activity_survey',
      targetId: survey.id,
      result: 'success',
      metadata: { from, to: 'ended', survey_code: survey.get('survey_code') },
    });
  });
  return e.json(200, { id: survey.id, status: 'ended' });
});

// ---------------------------------------------------------------------------
// 端点 3：GET /api/cc/surveys/{qrToken} — 问卷元信息 + 资格四条件校验结果
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/cc/surveys/{qrToken}', (e) => {
    // --- 内联共享 lib（JSVM 各 hooks 文件作用域完全隔离，lib 为「标准源」契约须内联使用，
  //     与 lib/http.pb.js 同实现；见 lib/audit.pb.js 顶部集成说明）---
  const jsonError = (e, status, code, message) => e.json(status, { code: status, message, data: { code } });
  // 统一错误：抛出标记对象，由 handler 顶层 catch 转为统一 JSON 错误响应
  // （new ApiError 的第三参数会被当作字段错误映射转换，无法携带自定义 data，0.28.4 实测）
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
      // 机构停用后其管理员不能进入业务后台（FR-ORG-001），历史数据保留
      let org = null;
      try {
        org = e.app.findRecordById('organizations', auth.get('organization_id'));
      } catch (_) {
        org = null;
      }
      if (!org || org.get('status') !== 'active') ccError(403, 'ORG_DISABLED', '所属机构已停用');
      return auth;
    }
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };

  // json 字段读取解码（JSVM 返回原始 JSON 字节数组）
  const decodeJson = (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch (_) {
        return v;
      }
    }
    if (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'number')) {
      let s = '';
      let i = 0;
      while (i < v.length) {
        const b = v[i];
        if (b < 0x80) {
          s += String.fromCharCode(b);
          i += 1;
        } else if (b < 0xe0) {
          s += String.fromCharCode(((b & 0x1f) << 6) | (v[i + 1] & 0x3f));
          i += 2;
        } else if (b < 0xf0) {
          s += String.fromCharCode(((b & 0x0f) << 12) | ((v[i + 1] & 0x3f) << 6) | (v[i + 2] & 0x3f));
          i += 3;
        } else {
          let cp = ((b & 0x07) << 18) | ((v[i + 1] & 0x3f) << 12) | ((v[i + 2] & 0x3f) << 6) | (v[i + 3] & 0x3f);
          cp -= 0x10000;
          s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
          i += 4;
        }
      }
      try {
        return JSON.parse(s);
      } catch (_) {
        return v;
      }
    }
    return v;
  };

  let auth;
  try {
    auth = requireAuth(e, 'participant');
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }

  let survey;
  try {
    survey = $app.findFirstRecordByFilter('activity_surveys', 'qr_token = {:t}', { t: e.request.pathValue('qrToken') });
  } catch (_) {
    return jsonError(e, 404, 'not_found', '问卷不存在或链接无效');
  }

  // 资格四条件校验（FR-SUR-006）：登录 / 报名已通过 / 角色匹配 / 开放中；未签到不强制（PRD §5.6）
  const checks = {
    logged_in: true,
    registration_approved: false,
    role_match: false,
    is_open: survey.get('status') === 'open',
  };
  let registration = null;
  try {
    registration = $app.findFirstRecordByFilter(
      'registrations',
      "activity_id = {:aid} && participant_id = {:pid} && status = 'approved'",
      { aid: survey.get('activity_id'), pid: auth.id },
    );
  } catch (_) {
    registration = null;
  }
  checks.registration_approved = !!registration;
  if (registration) {
    const scope = survey.get('role_scope');
    checks.role_match = scope === 'both' || scope === registration.get('activity_role');
  }
  const eligible =
    checks.logged_in && checks.registration_approved && checks.role_match && checks.is_open;

  const activity = $app.findRecordById('activities', survey.get('activity_id'));

  // 本人答卷状态（草稿/已提交/已作废），用于前端路由到填写或只读页
  let mySubmission = null;
  try {
    const sub = $app.findFirstRecordByFilter(
      'submissions',
      'activity_survey_id = {:sid} && participant_id = {:pid}',
      { sid: survey.id, pid: auth.id },
    );
    mySubmission = { id: sub.id, status: sub.get('status'), submitted_at: sub.get('submitted_at') };
  } catch (_) {
    mySubmission = null;
  }

  // 资格失败原因分因列表（前端按原因分开展示，FR-SUR-006）
  const reasons = [];
  if (!checks.registration_approved) reasons.push('not_approved');
  else if (!checks.role_match) reasons.push('role_mismatch');
  if (!checks.is_open) reasons.push(survey.get('status') === 'ended' ? 'ended' : 'not_open');

  const result = {
    survey: {
      id: survey.id,
      activity_id: activity.id,
      survey_code: survey.get('survey_code'),
      title: survey.get('title'),
      role_scope: survey.get('role_scope'),
      status: survey.get('status'),
    },
    activity: {
      id: activity.id,
      title: activity.get('title'),
    },
    eligible,
    reasons: eligible ? [] : reasons,
    my_submission: mySubmission,
    questions: [],
  };

  // 题目下发：资格全过，或本人已有答卷（草稿预填 / 已提交只读回看，FR-SUR-008/009）；
  // 其余情况不下发题目（迁移 1785888780：题目按问卷资格下发）
  if (eligible || mySubmission) {
    const questions = $app.findRecordsByFilter(
      'survey_questions',
      'activity_survey_id = {:sid}',
      'order_index',
      500,
      0,
      { sid: survey.id },
    );
    result.questions = questions.map((q) => ({
      id: q.id,
      activity_survey_id: q.get('activity_survey_id'),
      question_code: q.get('question_code'),
      source_type: q.get('source_type'),
      question_type: q.get('question_type'),
      title: q.get('title'),
      required: q.get('required'),
      options_json: decodeJson(q.get('options_json')),
      locked: q.get('locked'),
      is_sensitive: q.get('is_sensitive'),
      order_index: q.get('order_index'),
      validation_json: decodeJson(q.get('validation_json')),
    }));
  }

  // 本人已有答案（草稿预填 / 已提交只读展示），元素 { question_code, value }
  if (mySubmission) {
    const myAnswers = $app.findRecordsByFilter(
      'answers',
      'submission_id = {:sid}',
      'question_code',
      500,
      0,
      { sid: mySubmission.id },
    );
    result.my_answers = myAnswers.map((a) => ({
      question_code: a.get('question_code'),
      value: decodeJson(a.get('value_json')),
    }));
  }
  return e.json(200, result);
});

// ---------------------------------------------------------------------------
// 守卫 1：activity_surveys 直连 API 限制
// - 创建必须走 POST /api/cc/activities/{id}/surveys（保证题目物化与 qr_token 生成）；
// - 状态变更必须走 open|close 端点（保证状态机与审计）。
// 超级管理员放行（模板初始化/运维场景）。
// ---------------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('活动问卷创建须通过 /api/cc/activities/{id}/surveys 端点（模板复制）');
  }
  e.next();
}, 'activity_surveys');

onRecordUpdateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    const before = e.record.original().get('status');
    const after = e.record.get('status');
    if (before !== after) {
      throw new ForbiddenError('问卷状态变更须通过 /api/cc/activity-surveys/{id}/open|close 端点');
    }
  }
  e.next();
}, 'activity_surveys');

// ---------------------------------------------------------------------------
// 守卫 2：survey_questions 题目编辑守卫
// - 锁定题（locked=true）禁改（FR-SUR-001）；超级管理员放行；
// - 机构新增题目只能是自定义题（source_type=custom 且 locked=false，FR-SUR-002）；
// - question_code 不可变更（PRD §8.3 稳定机器字段）；自定义题不可改为标准题/锁定题。
// ---------------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    if (e.record.get('locked') || e.record.get('source_type') !== 'custom') {
      throw new ForbiddenError('机构仅可新增自定义题（source_type=custom 且非锁定）');
    }
  }
  e.next();
}, 'survey_questions');

onRecordUpdateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    const original = e.record.original();
    if (original.get('locked')) {
      throw new ForbiddenError('锁定题不可修改（FR-SUR-001）');
    }
    if (original.get('question_code') !== e.record.get('question_code')) {
      throw new ForbiddenError('question_code 为稳定机器字段，不可变更');
    }
    if (e.record.get('locked') || e.record.get('source_type') !== 'custom') {
      throw new ForbiddenError('不可将自定义题改为标准题或锁定题');
    }
  }
  e.next();
}, 'survey_questions');
