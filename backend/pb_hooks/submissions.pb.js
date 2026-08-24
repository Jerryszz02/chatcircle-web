// Chat Circles — submissions.pb.js：答卷域 hooks（后端 B）
// 职责（technical-design §5.5、PRD §4.5/§5.6、FR-SUR-006/008/009/010、AC-12/AC-20）：
// - POST /api/cc/activity-surveys/{id}/draft：保存草稿（可反复修改，同一行状态变更，不产生第二行）；
// - POST /api/cc/activity-surveys/{id}/submit：正式提交（必填校验 + 提交即锁定 + 幂等：
//   重复提交返回原记录；草稿→提交为原子切换，answers 同事务写入，database-design §5.6）；
// - GET /api/cc/submissions/{id}：本人已提交答案只读（FR-SUR-009）；
//   响应 { submission, survey_title, activity_title, questions, answers }，
//   答案元素 { question_code, value }；
// - POST /api/cc/submissions/{id}/void：管理员作废答卷（原因必填 + 审计，FR-SUR-010；
//   作废记录常规统计与导出口径排除，database-design §5.2.16）；
// - GET /api/cc/me/overview：参与者「我的」中心聚合（FR-PAR-001、PRD §6.7）：
//   { registrations: [{ registration, activity }], open_surveys: [{ survey（含 qr_token）,
//   activity_title, my_submission }], submissions: [{ submission, survey_title,
//   survey_qr_token, activity_title }], has_approved_listener_registration: bool
//   （存在 approved 聆听者报名，供培训入口显隐，见 trainings.pb.js） }。
// 资格四条件（登录 / 报名已通过 / 角色匹配 / 开放中）服务端逐项校验（FR-SUR-006），未签到不强制（PRD §5.6）。
// 守卫：submissions / answers 的直连 API 写操作一律禁止，必须走上述端点（唯一服务端强制点）。
//
// 实现注意（PocketBase 0.28 JSVM 实测）：handler 在请求期以全新作用域执行，文件级函数/常量
// 对 handler 不可见，故每个 handler 自包含、共享 lib 在 handler 内 require。

// ---------------------------------------------------------------------------
// POST /api/cc/activity-surveys/{id}/draft — 保存草稿
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activity-surveys/{id}/draft', (e) => {
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
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return v; } }
    if (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'number')) {
      let s = ''; let i = 0;
      while (i < v.length) {
        const b = v[i];
        if (b < 0x80) { s += String.fromCharCode(b); i += 1; }
        else if (b < 0xe0) { s += String.fromCharCode(((b & 0x1f) << 6) | (v[i + 1] & 0x3f)); i += 2; }
        else if (b < 0xf0) { s += String.fromCharCode(((b & 0x0f) << 12) | ((v[i + 1] & 0x3f) << 6) | (v[i + 2] & 0x3f)); i += 3; }
        else { let cp = ((b & 0x07) << 18) | ((v[i + 1] & 0x3f) << 12) | ((v[i + 2] & 0x3f) << 6) | (v[i + 3] & 0x3f); cp -= 0x10000; s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); i += 4; }
      }
      try { return JSON.parse(s); } catch (_) { return v; }
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
    survey = $app.findRecordById('activity_surveys', e.request.pathValue('id'));
  } catch (_) {
    return jsonError(e, 404, 'not_found', '活动问卷不存在');
  }

  // 资格四条件（FR-SUR-006）
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
  const roleMatch =
    !!registration &&
    (survey.get('role_scope') === 'both' || survey.get('role_scope') === registration.get('activity_role'));
  if (!registration || !roleMatch || survey.get('status') !== 'open') {
    const failed = [];
    if (!registration) failed.push('报名未通过');
    if (registration && !roleMatch) failed.push('角色不匹配');
    if (survey.get('status') !== 'open') failed.push('问卷未开放');
    return jsonError(e, 403, 'survey_not_eligible', '问卷填写资格校验未通过：' + failed.join('、'));
  }

  // 归一化 answers 入参：[{question_code, value}]；未提供 value（或显式 null）的项跳过
  // （保留已有草稿，不归一为 null 清空；answers.value_json required，null 落库会被拒）
  const body = e.requestInfo().body || {};
  const answersInput = (Array.isArray(body.answers) ? body.answers : [])
    .filter((a) => a && typeof a.question_code === 'string' && a.question_code !== '')
    .filter((a) => a.value !== undefined && a.value !== null)
    .map((a) => ({ question_code: a.question_code, value: a.value }));

  // question_code 必须属于本问卷
  const questions = $app.findRecordsByFilter(
    'survey_questions',
    'activity_survey_id = {:sid}',
    'order_index',
    500,
    0,
    { sid: survey.id },
  );
  const byCode = {};
  questions.forEach((q) => {
    byCode[q.get('question_code')] = q;
  });
  // 答案值形态校验：选择题须为选项成员、scale_1_5 须 1-5 整数、scale_0_10 须 0-10 整数、
  // 文本 ≤2000 字符；空值跳过（未作答项由提交侧必填校验兜底）
  const answerValueError = (q, value) => {
    const code = q.get('question_code');
    const type = q.get('question_type');
    if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return null;
    if (type === 'single_choice' || type === 'multi_choice') {
      if (type === 'single_choice' && typeof value !== 'string') return '题目 ' + code + ' 须为单选值';
      if (type === 'multi_choice' && (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))) {
        return '题目 ' + code + ' 须为选项数组';
      }
      const opts = decodeJson(q.get('options_json'));
      const list = Array.isArray(opts) ? opts : (opts && Array.isArray(opts.options) ? opts.options : []);
      const allowed = list.map((o) => (typeof o === 'string' ? o : o && o.value)).filter((v) => typeof v === 'string');
      if (allowed.length === 0) return null; // 无可解析选项定义时不做强校验
      const values = type === 'single_choice' ? [value] : value;
      for (const v of values) {
        if (allowed.indexOf(v) < 0) return '题目 ' + code + ' 含非法选项值';
      }
      return null;
    }
    if (type === 'scale_1_5') {
      if (!Number.isInteger(value) || value < 1 || value > 5) return '题目 ' + code + ' 须为 1~5 的整数';
      return null;
    }
    if (type === 'scale_0_10') {
      if (!Number.isInteger(value) || value < 0 || value > 10) return '题目 ' + code + ' 须为 0~10 的整数';
      return null;
    }
    if (type === 'text_short' || type === 'text_long') {
      if (typeof value !== 'string') return '题目 ' + code + ' 须为文本';
      if (value.length > 2000) return '题目 ' + code + ' 文本长度不可超过 2000 字符';
      return null;
    }
    return null; // info / 其他类型不校验
  };
  for (const a of answersInput) {
    if (!byCode[a.question_code]) {
      return jsonError(e, 400, 'validation_failed', '答案包含不属于本问卷的 question_code：' + a.question_code);
    }
    const valueError = answerValueError(byCode[a.question_code], a.value);
    if (valueError) {
      return jsonError(e, 400, 'validation_failed', valueError);
    }
  }

  try {
    let result;
    $app.runInTransaction((txApp) => {
      let sub = null;
      try {
        sub = txApp.findFirstRecordByFilter(
          'submissions',
          'activity_survey_id = {:sid} && participant_id = {:pid}',
          { sid: survey.id, pid: auth.id },
        );
      } catch (_) {
        sub = null;
      }
      if (sub && sub.get('status') === 'submitted') {
        throw new Error('LOCKED'); // 已提交锁定，草稿请求拒绝
      }
      if (sub && sub.get('status') === 'voided') {
        throw new Error('VOIDED');
      }
      if (!sub) {
        const subsCol = txApp.findCollectionByNameOrId('submissions');
        sub = new Record(subsCol);
        sub.set('activity_survey_id', survey.id);
        sub.set('participant_id', auth.id);
        sub.set('registration_id', registration.id);
        sub.set('status', 'draft');
      }
      txApp.save(sub);

      // 按 (submission_id, question_code) upsert 答案行；草稿可反复修改
      const answersCol = txApp.findCollectionByNameOrId('answers');
      for (const a of answersInput) {
        let row = null;
        try {
          row = txApp.findFirstRecordByFilter(
            'answers',
            'submission_id = {:sid} && question_code = {:qc}',
            { sid: sub.id, qc: a.question_code },
          );
        } catch (_) {
          row = null;
        }
        if (!row) {
          row = new Record(answersCol);
          row.set('submission_id', sub.id);
          row.set('question_code', a.question_code);
        }
        row.set('value_json', a.value);
        txApp.save(row);
      }
      result = sub;
    });

    const answers = $app.findRecordsByFilter('answers', 'submission_id = {:sid}', 'question_code', 500, 0, {
      sid: result.id,
    });
    return e.json(200, {
      submission: {
        id: result.id,
        activity_survey_id: result.get('activity_survey_id'),
        registration_id: result.get('registration_id'),
        status: result.get('status'),
        submitted_at: result.get('submitted_at'),
        answers: answers.map((a) => ({ question_code: a.get('question_code'), value: decodeJson(a.get('value_json')) })),
      },
    });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    if (String(err).indexOf('LOCKED') >= 0) {
      return jsonError(e, 409, 'submission_locked', '答卷已提交并锁定，不可再修改');
    }
    if (String(err).indexOf('VOIDED') >= 0) {
      return jsonError(e, 409, 'submission_voided', '答卷已被作废，V1 不支持重新填写');
    }
    // 内部错误细节不回传客户端（仅服务端日志可读）
    return jsonError(e, 500, 'internal_error', '草稿保存失败，请稍后重试');
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/activity-surveys/{id}/submit — 正式提交（锁定 + 幂等）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activity-surveys/{id}/submit', (e) => {
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
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return v; } }
    if (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'number')) {
      let s = ''; let i = 0;
      while (i < v.length) {
        const b = v[i];
        if (b < 0x80) { s += String.fromCharCode(b); i += 1; }
        else if (b < 0xe0) { s += String.fromCharCode(((b & 0x1f) << 6) | (v[i + 1] & 0x3f)); i += 2; }
        else if (b < 0xf0) { s += String.fromCharCode(((b & 0x0f) << 12) | ((v[i + 1] & 0x3f) << 6) | (v[i + 2] & 0x3f)); i += 3; }
        else { let cp = ((b & 0x07) << 18) | ((v[i + 1] & 0x3f) << 12) | ((v[i + 2] & 0x3f) << 6) | (v[i + 3] & 0x3f); cp -= 0x10000; s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); i += 4; }
      }
      try { return JSON.parse(s); } catch (_) { return v; }
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
    survey = $app.findRecordById('activity_surveys', e.request.pathValue('id'));
  } catch (_) {
    return jsonError(e, 404, 'not_found', '活动问卷不存在');
  }

  // 资格四条件（FR-SUR-006）
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
  const roleMatch =
    !!registration &&
    (survey.get('role_scope') === 'both' || survey.get('role_scope') === registration.get('activity_role'));
  if (!registration || !roleMatch || survey.get('status') !== 'open') {
    const failed = [];
    if (!registration) failed.push('报名未通过');
    if (registration && !roleMatch) failed.push('角色不匹配');
    if (survey.get('status') !== 'open') failed.push('问卷未开放');
    return jsonError(e, 403, 'survey_not_eligible', '问卷填写资格校验未通过：' + failed.join('、'));
  }

  const body = e.requestInfo().body || {};
  // 归一化 answers 入参（与 draft 同口径）：未提供 value（或显式 null）的项跳过（沿用已有
  // 草稿，不归一为 null 清空；answers.value_json required，null 落库会被拒）
  const answersInput = (Array.isArray(body.answers) ? body.answers : [])
    .filter((a) => a && typeof a.question_code === 'string' && a.question_code !== '')
    .filter((a) => a.value !== undefined && a.value !== null)
    .map((a) => ({ question_code: a.question_code, value: a.value }));

  // 题目校验：question_code 归属 + 答案值形态 + 必填题（说明题除外）非空
  const questions = $app.findRecordsByFilter(
    'survey_questions',
    'activity_survey_id = {:sid}',
    'order_index',
    500,
    0,
    { sid: survey.id },
  );
  const byCode = {};
  questions.forEach((q) => {
    byCode[q.get('question_code')] = q;
  });
  // 答案值形态校验：选择题须为选项成员、scale_1_5 须 1-5 整数、scale_0_10 须 0-10 整数、
  // 文本 ≤2000 字符；空值跳过（由下方必填校验兜底）
  const answerValueError = (q, value) => {
    const code = q.get('question_code');
    const type = q.get('question_type');
    if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return null;
    if (type === 'single_choice' || type === 'multi_choice') {
      if (type === 'single_choice' && typeof value !== 'string') return '题目 ' + code + ' 须为单选值';
      if (type === 'multi_choice' && (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))) {
        return '题目 ' + code + ' 须为选项数组';
      }
      const opts = decodeJson(q.get('options_json'));
      const list = Array.isArray(opts) ? opts : (opts && Array.isArray(opts.options) ? opts.options : []);
      const allowed = list.map((o) => (typeof o === 'string' ? o : o && o.value)).filter((v) => typeof v === 'string');
      if (allowed.length === 0) return null; // 无可解析选项定义时不做强校验
      const values = type === 'single_choice' ? [value] : value;
      for (const v of values) {
        if (allowed.indexOf(v) < 0) return '题目 ' + code + ' 含非法选项值';
      }
      return null;
    }
    if (type === 'scale_1_5') {
      if (!Number.isInteger(value) || value < 1 || value > 5) return '题目 ' + code + ' 须为 1~5 的整数';
      return null;
    }
    if (type === 'scale_0_10') {
      if (!Number.isInteger(value) || value < 0 || value > 10) return '题目 ' + code + ' 须为 0~10 的整数';
      return null;
    }
    if (type === 'text_short' || type === 'text_long') {
      if (typeof value !== 'string') return '题目 ' + code + ' 须为文本';
      if (value.length > 2000) return '题目 ' + code + ' 文本长度不可超过 2000 字符';
      return null;
    }
    return null; // info / 其他类型不校验
  };
  for (const a of answersInput) {
    if (!byCode[a.question_code]) {
      return jsonError(e, 400, 'validation_failed', '答案包含不属于本问卷的 question_code：' + a.question_code);
    }
    const valueError = answerValueError(byCode[a.question_code], a.value);
    if (valueError) {
      return jsonError(e, 400, 'validation_failed', valueError);
    }
  }
  // 必填校验合并服务端已有草稿答案（本次请求未覆盖的必填题沿用草稿值，非只看请求体）
  const answerMap = {};
  let draftSub = null;
  try {
    draftSub = $app.findFirstRecordByFilter(
      'submissions',
      'activity_survey_id = {:sid} && participant_id = {:pid}',
      { sid: survey.id, pid: auth.id },
    );
  } catch (_) {
    draftSub = null;
  }
  if (draftSub && draftSub.get('status') === 'draft') {
    const draftRows = $app.findRecordsByFilter('answers', 'submission_id = {:sid}', '', 500, 0, { sid: draftSub.id });
    draftRows.forEach((row) => {
      answerMap[row.get('question_code')] = decodeJson(row.get('value_json'));
    });
  }
  answersInput.forEach((a) => {
    answerMap[a.question_code] = a.value;
  });
  const missing = questions
    .filter((q) => q.get('required') && q.get('question_type') !== 'info')
    .filter((q) => {
      const v = answerMap[q.get('question_code')];
      return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    })
    .map((q) => q.get('question_code'));
  if (missing.length > 0) {
    return jsonError(e, 400, 'validation_failed', '存在未作答的必填题：' + missing.join(', '));
  }

  try {
    let result;
    let idempotent = false;
    $app.runInTransaction((txApp) => {
      let sub = null;
      try {
        sub = txApp.findFirstRecordByFilter(
          'submissions',
          'activity_survey_id = {:sid} && participant_id = {:pid}',
          { sid: survey.id, pid: auth.id },
        );
      } catch (_) {
        sub = null;
      }
      if (sub && sub.get('status') === 'submitted') {
        // 幂等：重复提交返回原记录，不产生重复正式记录（AC-20）
        idempotent = true;
        result = sub;
        return;
      }
      if (sub && sub.get('status') === 'voided') {
        throw new Error('VOIDED');
      }
      if (!sub) {
        const subsCol = txApp.findCollectionByNameOrId('submissions');
        sub = new Record(subsCol);
        sub.set('activity_survey_id', survey.id);
        sub.set('participant_id', auth.id);
        sub.set('registration_id', registration.id);
      }
      sub.set('status', 'submitted');
      sub.set('submitted_at', new Date().toISOString());
      txApp.save(sub);

      const answersCol = txApp.findCollectionByNameOrId('answers');
      for (const a of answersInput) {
        let row = null;
        try {
          row = txApp.findFirstRecordByFilter(
            'answers',
            'submission_id = {:sid} && question_code = {:qc}',
            { sid: sub.id, qc: a.question_code },
          );
        } catch (_) {
          row = null;
        }
        if (!row) {
          row = new Record(answersCol);
          row.set('submission_id', sub.id);
          row.set('question_code', a.question_code);
        }
        row.set('value_json', a.value);
        txApp.save(row);
      }
      result = sub;
    });

    const answers = $app.findRecordsByFilter('answers', 'submission_id = {:sid}', 'question_code', 500, 0, {
      sid: result.id,
    });
    return e.json(200, {
      submission: {
        id: result.id,
        activity_survey_id: result.get('activity_survey_id'),
        registration_id: result.get('registration_id'),
        status: result.get('status'),
        submitted_at: result.get('submitted_at'),
        answers: answers.map((a) => ({ question_code: a.get('question_code'), value: decodeJson(a.get('value_json')) })),
      },
      idempotent,
    });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    if (String(err).indexOf('VOIDED') >= 0) {
      return jsonError(e, 409, 'submission_voided', '答卷已被作废，V1 不支持重新填写');
    }
    // 内部错误细节不回传客户端（仅服务端日志可读）
    return jsonError(e, 500, 'internal_error', '答卷提交失败，请稍后重试');
  }
});

// ---------------------------------------------------------------------------
// GET /api/cc/submissions/{id} — 本人已提交答案只读（FR-SUR-009）
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/cc/submissions/{id}', (e) => {
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
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return v; } }
    if (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'number')) {
      let s = ''; let i = 0;
      while (i < v.length) {
        const b = v[i];
        if (b < 0x80) { s += String.fromCharCode(b); i += 1; }
        else if (b < 0xe0) { s += String.fromCharCode(((b & 0x1f) << 6) | (v[i + 1] & 0x3f)); i += 2; }
        else if (b < 0xf0) { s += String.fromCharCode(((b & 0x0f) << 12) | ((v[i + 1] & 0x3f) << 6) | (v[i + 2] & 0x3f)); i += 3; }
        else { let cp = ((b & 0x07) << 18) | ((v[i + 1] & 0x3f) << 12) | ((v[i + 2] & 0x3f) << 6) | (v[i + 3] & 0x3f); cp -= 0x10000; s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); i += 4; }
      }
      try { return JSON.parse(s); } catch (_) { return v; }
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
  let sub;
  try {
    sub = $app.findRecordById('submissions', e.request.pathValue('id'));
  } catch (_) {
    return jsonError(e, 404, 'not_found', '答卷不存在');
  }
  if (sub.get('participant_id') !== auth.id) {
    return jsonError(e, 403, 'forbidden', '仅可查看本人答卷');
  }
  const answers = $app.findRecordsByFilter('answers', 'submission_id = {:sid}', 'question_code', 500, 0, {
    sid: sub.id,
  });
  // 题目快照随只读详情下发（前端按题目渲染只读答案，FR-SUR-009）
  const questions = $app.findRecordsByFilter(
    'survey_questions',
    'activity_survey_id = {:sid}',
    'order_index',
    500,
    0,
    { sid: sub.get('activity_survey_id') },
  );
  const survey = $app.findRecordById('activity_surveys', sub.get('activity_survey_id'));
  const activity = $app.findRecordById('activities', survey.get('activity_id'));
  return e.json(200, {
    submission: {
      id: sub.id,
      activity_survey_id: sub.get('activity_survey_id'),
      registration_id: sub.get('registration_id'),
      status: sub.get('status'),
      submitted_at: sub.get('submitted_at'),
    },
    survey_title: survey.get('title'),
    activity_title: activity.get('title'),
    questions: questions.map((q) => ({
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
    })),
    // 答案元素 { question_code, value }（与 draft/submit/me/overview 出参形态一致）
    answers: answers.map((a) => ({ question_code: a.get('question_code'), value: decodeJson(a.get('value_json')) })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/cc/submissions/{id}/void — 管理员作废答卷（原因必填 + 审计，FR-SUR-010）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/submissions/{id}/void', (e) => {
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
  let sub;
  try {
    sub = $app.findRecordById('submissions', e.request.pathValue('id'));
  } catch (_) {
    return jsonError(e, 404, 'not_found', '答卷不存在');
  }
  // 机构隔离：答卷所属活动的机构必须与本管理员一致（FR-ORG-006）
  const survey = $app.findRecordById('activity_surveys', sub.get('activity_survey_id'));
  const activity = $app.findRecordById('activities', survey.get('activity_id'));
  if (activity.get('organization_id') !== auth.get('organization_id')) {
    return jsonError(e, 403, 'forbidden', '无权操作其他机构的答卷');
  }

  const body = e.requestInfo().body || {};
  const reason = (body.reason || '').trim();
  if (!reason) {
    return jsonError(e, 400, 'validation_failed', '作废必须填写原因');
  }
  if (sub.get('status') !== 'submitted') {
    return jsonError(e, 400, 'invalid_transition', '仅已提交的答卷可作废，当前状态：' + sub.get('status'));
  }

  // 业务写 + 审计同事务提交（作废状态与留痕不可分）
  $app.runInTransaction((txApp) => {
    sub.set('status', 'voided');
    sub.set('voided_by', auth.id);
    sub.set('voided_at', new Date().toISOString());
    sub.set('void_reason', reason);
    txApp.save(sub);

    writeAudit(txApp, {
      actorId: auth.id,
      actorRole: 'admin',
      organizationId: auth.get('organization_id'),
      action: 'submission.void',
      targetType: 'submission',
      targetId: sub.id,
      result: 'success',
      reason,
      metadata: { from: 'submitted', to: 'voided', activity_survey_id: survey.id },
    });
  });
  return e.json(200, { id: sub.id, status: 'voided' });
});

// ---------------------------------------------------------------------------
// GET /api/cc/me/overview — 参与者「我的」中心聚合
// 本人报名列表（含活动信息与状态）+ 可填开放问卷入口 + 已提交答卷索引
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/cc/me/overview', (e) => {
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
    auth = requireAuth(e, 'participant');
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }

  const registrations = $app.findRecordsByFilter(
    'registrations',
    'participant_id = {:pid}',
    '-created',
    200,
    0,
    { pid: auth.id },
  );

  // 聆听者培训资格标记：存在任一 approved 的 listener 报名（培训页入口显隐，与
  // trainings.pb.js 的资格校验同一口径）
  const hasApprovedListenerRegistration = registrations.some(
    (r) => r.get('status') === 'approved' && r.get('activity_role') === 'listener',
  );

  const activityCache = {};
  const getActivity = (id) => {
    if (!activityCache[id]) {
      activityCache[id] = $app.findRecordById('activities', id);
    }
    return activityCache[id];
  };
  const activityBrief = (a) => ({
    id: a.id,
    title: a.get('title'),
    activity_code: a.get('activity_code'),
    status: a.get('status'),
    start_time: a.get('start_time'),
    end_time: a.get('end_time'),
    location: a.get('location'),
  });

  // 本人答卷索引（按问卷取状态），供入口与已提交列表复用
  const mySubs = $app.findRecordsByFilter('submissions', 'participant_id = {:pid}', '-created', 200, 0, {
    pid: auth.id,
  });
  const subBySurvey = {};
  mySubs.forEach((s) => {
    subBySurvey[s.get('activity_survey_id')] = s;
  });

  // 可填开放问卷入口：报名已通过 + 问卷 open + 角色匹配（FR-SUR-006，PRD §6.7）
  const openSurveys = [];
  registrations
    .filter((r) => r.get('status') === 'approved')
    .forEach((r) => {
      const found = $app.findRecordsByFilter(
        'activity_surveys',
        "activity_id = {:aid} && status = 'open'",
        'created',
        100,
        0,
        { aid: r.get('activity_id') },
      );
      found.forEach((sv) => {
        const scope = sv.get('role_scope');
        if (scope !== 'both' && scope !== r.get('activity_role')) return;
        const sub = subBySurvey[sv.id];
        openSurveys.push({
          survey: {
            id: sv.id,
            title: sv.get('title'),
            role_scope: scope,
            status: sv.get('status'),
            qr_token: sv.get('qr_token'),
          },
          activity_title: getActivity(sv.get('activity_id')).get('title'),
          my_submission: sub ? { id: sub.id, status: sub.get('status') } : null,
        });
      });
    });

  // 已提交答卷索引（仅正式提交；草稿不算已提交，作废不入索引）；
  // survey_qr_token 供前端构造只读页链接 /survey/:qrToken（FR-SUR-009）
  const submitted = mySubs
    .filter((s) => s.get('status') === 'submitted')
    .map((s) => {
      const sv = $app.findRecordById('activity_surveys', s.get('activity_survey_id'));
      return {
        submission: { id: s.id, status: s.get('status'), submitted_at: s.get('submitted_at') },
        survey_title: sv.get('title'),
        survey_qr_token: sv.get('qr_token'),
        activity_title: getActivity(sv.get('activity_id')).get('title'),
      };
    });

  return e.json(200, {
    registrations: registrations.map((r) => ({
      registration: {
        id: r.id,
        activity_id: r.get('activity_id'),
        participant_id: r.get('participant_id'),
        activity_role: r.get('activity_role'),
        status: r.get('status'),
        status_reason: r.get('status_reason'),
        submitted_at: r.get('submitted_at'),
        created: r.get('created'),
        updated: r.get('updated'),
      },
      activity: activityBrief(getActivity(r.get('activity_id'))),
    })),
    open_surveys: openSurveys,
    submissions: submitted,
    has_approved_listener_registration: hasApprovedListenerRegistration,
  });
});

// ---------------------------------------------------------------------------
// 守卫：submissions / answers 直连 API 写操作禁止（必须走 draft/submit/void 端点，
// 保证资格校验、锁定与事务语义为唯一服务端强制点，technical-design §5.5）。
// 超级管理员放行（运维/测试场景）。
// ---------------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('答卷写操作须通过 /api/cc/activity-surveys/{id}/draft|submit 端点');
  }
  e.next();
}, 'submissions');
onRecordUpdateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('答卷写操作须通过 /api/cc/activity-surveys/{id}/draft|submit 端点');
  }
  e.next();
}, 'submissions');
onRecordCreateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('答案写操作须通过 /api/cc/activity-surveys/{id}/draft|submit 端点');
  }
  e.next();
}, 'answers');
onRecordUpdateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('答案写操作须通过 /api/cc/activity-surveys/{id}/draft|submit 端点');
  }
  e.next();
}, 'answers');
