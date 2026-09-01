// Chat Circles — exports_v2.pb.js：细粒度导出 v2 预览端点（后端 T6）
// 职责（PRD §7、api-design §6、冻结契约 accountEvent.ts「细粒度导出」段）：
// - POST /api/cc/exports/preview：先预览后生成。返回归一化 selection、分数据域
//   预估行数、requires_sensitive_export、触发门槛的字段/题目代码与权限结果；
//   不返回任何实际数据值，不写审计（无敏感值暴露）。
// - 判敏必须与服务端正式导出同一判定函数（内联 lib/exportv2.pb.js 标准源），
//   前端只能展示 requires_sensitive_export 与原因，不能作为唯一门槛。
// - 范围服务端校验与旧导出一致（FR-EXP-004）：管理员=本机构全部或指定单活动，
//   超管=全平台/机构/单活动，忽略客户端越权参数。
//
// ⚠️ 本文件内联 backend/pb_hooks/lib/exportv2.pb.js 的标准源函数
// （JSVM 各 hooks 文件作用域完全隔离，无法跨文件引用；修改时与标准源保持同步，
// 另一处内联在 exports.pb.js 的创建端点）。

// ---------------------------------------------------------------------------
// 端点：POST /api/cc/exports/preview — 导出预览（先预览后生成）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/exports/preview', (e) => {
  // --- 内联 lib/http.pb.js（标准源，同 exports.pb.js）---
  const jsonError = (e, status, code, message) => e.json(status, { code: status, message, data: { code } });
  const ccError = (status, code, message) => { throw { __ccError: true, status: status, code: code, message: message }; };
  const requireAuth = (e, role) => {
    const auth = e.auth;
    if (!auth) ccError(401, 'UNAUTHORIZED', '请先登录');
    const collectionName = auth.collection().name;
    if (role === 'admin') {
      if (collectionName !== 'admin_accounts') ccError(403, 'FORBIDDEN', '无权限：需要机构管理员身份');
      if (auth.get('status') !== 'active') ccError(403, 'ACCOUNT_DISABLED', '账号已停用');
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

  // --- 内联 lib/exportv2.pb.js（标准源，T6 判敏唯一出处）---
  const EXPORT_V2_DATASETS = ['registrations', 'checkins', 'pairings', 'surveys'];
  const EXPORT_V2_FORMATS = ['xlsx', 'csv_zip'];
  const EXPORT_V2_SYSTEM_COLUMNS = [
    'participant_id', 'activity_id', 'activity_role', 'registration_status',
    'checked_in_at', 'onsite_code', 'pair_code', 'partner_name',
    'phone_masked', 'phone_full',
  ];
  const EXPORT_V2_SENSITIVE_SYSTEM_COLUMNS = ['phone_full', 'partner_name'];
  const EXPORT_V2_CHECKIN_FILTERS = ['any', 'valid', 'not_checked_in', 'revoked'];
  const EXPORT_V2_PAIRING_FILTERS = ['any', 'paired', 'waiting', 'unpaired'];
  const EXPORT_V2_SURVEY_COMPLETION_FILTERS = ['any', 'submitted', 'not_submitted'];
  const EXPORT_V2_ROLES = ['speaker', 'listener'];
  const EXPORT_V2_REGISTRATION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
  const EXPORT_V2_CONTRACT_VERSION = '2026-08-28.t0-v1';
  const EXPORT_V2_TIMEZONES = { 'UTC': 0, 'Asia/Shanghai': 480 };

  const exportV2StringArray = (v, maxLen) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) return null;
    const out = [];
    for (let i = 0; i < v.length; i++) {
      if (typeof v[i] !== 'string' || v[i] === '') return null;
      if (out.indexOf(v[i]) < 0) out.push(v[i]);
    }
    if (maxLen && out.length > maxLen) return null;
    return out;
  };
  const exportV2EnumArray = (v, allowed) => {
    const arr = exportV2StringArray(v, 0);
    if (arr === null) return null;
    for (let i = 0; i < arr.length; i++) {
      if (allowed.indexOf(arr[i]) < 0) return null;
    }
    return arr;
  };
  const exportV2TimezoneOffset = (tz) => {
    if (typeof tz !== 'string' || tz === '') return null;
    if (tz in EXPORT_V2_TIMEZONES) return EXPORT_V2_TIMEZONES[tz];
    const m = /^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(tz);
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    const hh = parseInt(m[2], 10);
    const mm = m[3] ? parseInt(m[3], 10) : 0;
    if (hh > 14 || mm > 59) return null;
    return sign * (hh * 60 + mm);
  };
  const exportV2OrgInClause = (orgIds) => {
    const parts = [];
    orgIds.forEach((id) => {
      if (!/^[A-Za-z0-9_]+$/.test(id)) return;
      parts.push("organization_id = '" + id + "'");
    });
    return parts.length ? '(' + parts.join(' || ') + ')' : "organization_id = '__no_such_org__'";
  };
  const exportV2ActivityInClause = (activityIds) => {
    const parts = [];
    activityIds.forEach((id) => {
      if (!/^[A-Za-z0-9_]+$/.test(id)) return;
      parts.push("activity_id = '" + id + "'");
    });
    return parts.length ? '(' + parts.join(' || ') + ')' : "activity_id = '__no_such_activity__'";
  };
  const exportV2NormalizeScope = (scope) => {
    if (!scope || typeof scope !== 'object') ccError(400, 'validation_failed', 'scope 必填');
    const type = scope.type;
    if (['platform', 'organization', 'activity'].indexOf(type) < 0) {
      ccError(400, 'validation_failed', 'scope.type 必须为 platform / organization / activity');
    }
    const out = { type };
    if (type === 'organization') {
      if (scope.organization_id !== undefined && typeof scope.organization_id !== 'string') {
        ccError(400, 'validation_failed', 'scope.organization_id 须为字符串');
      }
      if (scope.organization_id) out.organization_id = scope.organization_id;
    }
    if (type === 'activity') {
      if (!scope.activity_id || typeof scope.activity_id !== 'string') {
        ccError(400, 'validation_failed', '单活动导出须指定 scope.activity_id');
      }
      out.activity_id = scope.activity_id;
    }
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const dr = scope.date_range || {};
    if (dr.from !== undefined && (typeof dr.from !== 'string' || !DATE_RE.test(dr.from))) {
      ccError(400, 'validation_failed', 'scope.date_range.from 须为 YYYY-MM-DD 格式');
    }
    if (dr.to !== undefined && (typeof dr.to !== 'string' || !DATE_RE.test(dr.to))) {
      ccError(400, 'validation_failed', 'scope.date_range.to 须为 YYYY-MM-DD 格式');
    }
    if (dr.from || dr.to) out.date_range = { from: dr.from || undefined, to: dr.to || undefined };
    return out;
  };
  const exportV2NormalizeSelection = (body) => {
    if (!body || typeof body !== 'object') ccError(400, 'validation_failed', '请求体必填');
    if (body.schema_version !== 2) ccError(400, 'validation_failed', '细粒度导出请求须带 schema_version:2');
    const scope = exportV2NormalizeScope(body.scope);
    const datasets = exportV2EnumArray(body.datasets, EXPORT_V2_DATASETS);
    if (datasets === null || datasets.length === 0) {
      ccError(400, 'validation_failed', 'datasets 须为 registrations/checkins/pairings/surveys 的非空子集');
    }
    const surveyIds = exportV2StringArray(body.survey_ids, 200);
    if (surveyIds === null) ccError(400, 'validation_failed', 'survey_ids 须为活动问卷 id 数组（≤200）');
    const filtersIn = body.filters || {};
    if (typeof filtersIn !== 'object') ccError(400, 'validation_failed', 'filters 须为对象');
    const participantIds = exportV2StringArray(filtersIn.participant_ids, 500);
    if (participantIds === null) {
      ccError(400, 'validation_failed', 'filters.participant_ids 须为参与者 id 数组（≤500）');
    }
    const roles = exportV2EnumArray(filtersIn.activity_roles, EXPORT_V2_ROLES);
    if (roles === null) ccError(400, 'validation_failed', 'filters.activity_roles 非法');
    const statuses = exportV2EnumArray(filtersIn.registration_statuses, EXPORT_V2_REGISTRATION_STATUSES);
    if (statuses === null) ccError(400, 'validation_failed', 'filters.registration_statuses 非法');
    const checkin = filtersIn.checkin === undefined ? 'any' : filtersIn.checkin;
    if (EXPORT_V2_CHECKIN_FILTERS.indexOf(checkin) < 0) {
      ccError(400, 'validation_failed', 'filters.checkin 须为 any/valid/not_checked_in/revoked');
    }
    const pairing = filtersIn.pairing === undefined ? 'any' : filtersIn.pairing;
    if (EXPORT_V2_PAIRING_FILTERS.indexOf(pairing) < 0) {
      ccError(400, 'validation_failed', 'filters.pairing 须为 any/paired/waiting/unpaired');
    }
    const surveyCompletion = filtersIn.survey_completion === undefined ? 'any' : filtersIn.survey_completion;
    if (EXPORT_V2_SURVEY_COMPLETION_FILTERS.indexOf(surveyCompletion) < 0) {
      ccError(400, 'validation_failed', 'filters.survey_completion 须为 any/submitted/not_submitted');
    }
    const columnsIn = body.columns || {};
    if (typeof columnsIn !== 'object') ccError(400, 'validation_failed', 'columns 须为对象');
    const systemColumns = exportV2EnumArray(columnsIn.system, EXPORT_V2_SYSTEM_COLUMNS);
    if (systemColumns === null) ccError(400, 'validation_failed', 'columns.system 含非法系统列');
    const fieldCodes = exportV2StringArray(columnsIn.registration_field_codes, 200);
    if (fieldCodes === null || fieldCodes.indexOf('*') >= 0) {
      ccError(400, 'validation_failed', 'columns.registration_field_codes 须为显式字段代码数组（≤200）');
    }
    const questionSelections = [];
    if (columnsIn.survey_questions !== undefined) {
      if (!Array.isArray(columnsIn.survey_questions)) {
        ccError(400, 'validation_failed', 'columns.survey_questions 须为数组');
      }
      for (let i = 0; i < columnsIn.survey_questions.length; i++) {
        const qs = columnsIn.survey_questions[i];
        if (!qs || typeof qs !== 'object' || typeof qs.activity_survey_id !== 'string' || !qs.activity_survey_id) {
          ccError(400, 'validation_failed', 'columns.survey_questions[].activity_survey_id 必填');
        }
        const codes = exportV2StringArray(qs.question_codes, 200);
        if (codes === null || codes.length === 0 || codes.indexOf('*') >= 0) {
          ccError(400, 'validation_failed', 'columns.survey_questions[].question_codes 须为显式题目代码非空数组');
        }
        questionSelections.push({ activity_survey_id: qs.activity_survey_id, question_codes: codes });
      }
    }
    if (datasets.indexOf('surveys') < 0 && questionSelections.length > 0) {
      ccError(400, 'validation_failed', '未选 surveys 数据域时不能选择问卷题目列');
    }
    const format = body.format === undefined ? 'xlsx' : body.format;
    if (EXPORT_V2_FORMATS.indexOf(format) < 0) ccError(400, 'validation_failed', 'format 须为 xlsx 或 csv_zip');
    const timezone = body.timezone === undefined ? 'Asia/Shanghai' : body.timezone;
    if (exportV2TimezoneOffset(timezone) === null) {
      ccError(400, 'validation_failed', 'timezone 仅支持 UTC / Asia/Shanghai / UTC±HH:MM');
    }
    return {
      schema_version: 2,
      scope,
      datasets,
      survey_ids: surveyIds,
      filters: {
        participant_ids: participantIds,
        activity_roles: roles,
        registration_statuses: statuses,
        checkin,
        pairing,
        survey_completion: surveyCompletion,
      },
      columns: { system: systemColumns, registration_field_codes: fieldCodes, survey_questions: questionSelections },
      format,
      timezone,
    };
  };
  const queryAll = (collection, filter, params, sort) => {
    const out = [];
    const pageSize = 500;
    let offset = 0;
    for (;;) {
      const page = $app.findRecordsByFilter(collection, filter, sort || '', pageSize, offset, params || {});
      if (!page || page.length === 0) break;
      out.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }
    return out;
  };
  const exportV2ResolveScope = (scope, role, authOrgId) => {
    const iso = (s) => (s ? String(s).replace(' ', 'T') : '');
    let orgConstraint = null;
    if (role === 'admin') {
      orgConstraint = authOrgId;
      if (scope.type !== 'organization' && scope.type !== 'activity') {
        ccError(403, 'scope_forbidden', '机构管理员仅可导出本机构全部或指定单活动');
      }
    } else {
      if (scope.type === 'organization') {
        if (!scope.organization_id) ccError(400, 'validation_failed', '机构范围导出须指定 scope.organization_id');
        try {
          $app.findRecordById('organizations', scope.organization_id);
        } catch (_) {
          ccError(400, 'validation_failed', 'scope.organization_id 无效');
        }
        orgConstraint = scope.organization_id;
      }
    }
    let activities;
    if (scope.type === 'activity') {
      let activity;
      try {
        activity = $app.findRecordById('activities', scope.activity_id);
      } catch (_) {
        ccError(404, 'not_found', '活动不存在');
      }
      if (orgConstraint && activity.get('organization_id') !== orgConstraint) {
        ccError(403, 'scope_forbidden', '无权导出其他机构的活动');
      }
      activities = [activity];
    } else if (orgConstraint) {
      activities = queryAll('activities', 'organization_id = {:o}', { o: orgConstraint }, 'created');
    } else {
      activities = queryAll('activities', '', {}, 'created');
    }
    const dr = scope.date_range || {};
    if (dr.from) {
      activities = activities.filter((a) => (iso(a.get('end_time')) || iso(a.get('start_time'))) >= dr.from);
    }
    if (dr.to) {
      activities = activities.filter((a) => iso(a.get('start_time')) <= dr.to + 'T23:59:59.999Z');
    }
    const organizationIds = [];
    activities.forEach((a) => {
      const o = a.get('organization_id');
      if (organizationIds.indexOf(o) < 0) organizationIds.push(o);
    });
    return { orgConstraint, activities, organizationIds };
  };
  const exportV2AnalyzeSelection = (selection, scopeOrgIds, scopeActivityIds) => {
    const reasons = [];
    const unknown = [];
    const fieldDefByCode = {};
    // 每个 field_code 的全部 scoped definition id（机构覆盖标准同码/超管跨机构时不止一个；取值反查遍实用）
    const fieldDefIdsByCode = {};
    const questionByKey = {};
    const pushReason = (source, code) => {
      for (let i = 0; i < reasons.length; i++) {
        if (reasons[i].source === source && reasons[i].code === code) return;
      }
      reasons.push({ source, code });
    };
    selection.columns.system.forEach((col) => {
      if (EXPORT_V2_SENSITIVE_SYSTEM_COLUMNS.indexOf(col) >= 0) pushReason('account_column', col);
    });
    selection.columns.registration_field_codes.forEach((code) => {
      let def = null;
      const found = $app.findRecordsByFilter(
        'registration_field_defs',
        "field_code = {:c} && (organization_id = '' || " + exportV2OrgInClause(scopeOrgIds) + ')',
        '',
        10,
        0,
        { c: code },
      );
      fieldDefIdsByCode[code] = [];
      found.forEach((d) => {
        fieldDefIdsByCode[code].push(d.id);
        if (d.get('organization_id') !== '') def = d;
      });
      if (!def && found.length > 0) def = found[0];
      if (!def) {
        unknown.push('registration_field:' + code);
        return;
      }
      fieldDefByCode[code] = def;
      if (def.get('is_sensitive')) pushReason('registration_field', code);
    });
    selection.columns.survey_questions.forEach((qs) => {
      let survey = null;
      try {
        survey = $app.findRecordById('activity_surveys', qs.activity_survey_id);
      } catch (_) {
        survey = null;
      }
      if (!survey || scopeActivityIds.indexOf(survey.get('activity_id')) < 0) {
        unknown.push('survey:' + qs.activity_survey_id);
        return;
      }
      qs.question_codes.forEach((qc) => {
        const found = $app.findRecordsByFilter(
          'survey_questions',
          'activity_survey_id = {:s} && question_code = {:q}',
          '',
          1,
          0,
          { s: qs.activity_survey_id, q: qc },
        );
        if (!found.length) {
          unknown.push('survey_question:' + qs.activity_survey_id + ':' + qc);
          return;
        }
        const q = found[0];
        questionByKey[qs.activity_survey_id + ':' + qc] = q;
        if (q.get('is_sensitive')) pushReason('survey_question', qc);
      });
    });
    return { requiresSensitive: reasons.length > 0, reasons, unknown, fieldDefByCode, fieldDefIdsByCode, questionByKey };
  };
  const exportV2BuildUniverse = (selection, activities) => {
    const filters = selection.filters;
    const activityIds = activities.map((a) => a.id);
    const empty = {
      activities,
      registrations: [],
      checkins: [],
      validCheckinByReg: {},
      pairs: [],
      activePairByReg: {},
      surveys: [],
      submissions: [],
      counts: { registrations: 0, checkins: 0, pairings: 0, surveys: 0 },
    };
    if (activityIds.length === 0) return empty;
    const actClause = exportV2ActivityInClause(activityIds);
    let registrations = queryAll('registrations', actClause, {}, 'created');
    const checkins = queryAll('checkins', actClause, {}, 'created');
    const pairs = queryAll('activity_pairs', actClause, {}, 'pair_sequence');
    let surveys = queryAll('activity_surveys', actClause, {}, 'created');
    if (selection.survey_ids.length > 0) {
      surveys = surveys.filter((s) => selection.survey_ids.indexOf(s.id) >= 0);
    }
    const surveyIds = surveys.map((s) => s.id);
    let submissions = [];
    if (surveyIds.length > 0) {
      const clause = [];
      surveyIds.forEach((id) => {
        if (/^[A-Za-z0-9_]+$/.test(id)) clause.push("activity_survey_id = '" + id + "'");
      });
      submissions = queryAll('submissions', '(' + clause.join(' || ') + ") && status != 'voided'", {}, 'created');
    }
    if (filters.participant_ids.length > 0) {
      registrations = registrations.filter((r) => filters.participant_ids.indexOf(r.get('participant_id')) >= 0);
    }
    if (filters.activity_roles.length > 0) {
      registrations = registrations.filter((r) => filters.activity_roles.indexOf(r.get('activity_role')) >= 0);
    }
    if (filters.registration_statuses.length > 0) {
      registrations = registrations.filter((r) => filters.registration_statuses.indexOf(r.get('status')) >= 0);
    }
    const validCheckinByReg = {};
    const revokedCheckinByReg = {};
    checkins.forEach((c) => {
      if (c.get('status') === 'valid') validCheckinByReg[c.get('registration_id')] = c;
      if (c.get('status') === 'revoked') revokedCheckinByReg[c.get('registration_id')] = c;
    });
    const activePairByReg = {};
    pairs.forEach((p) => {
      if (p.get('status') !== 'active') return;
      activePairByReg[p.get('speaker_registration_id')] = p;
      activePairByReg[p.get('listener_registration_id')] = p;
    });
    const submittedByReg = {};
    submissions.forEach((s) => {
      if (s.get('status') === 'submitted') submittedByReg[s.get('registration_id')] = true;
    });
    if (filters.checkin === 'valid') {
      registrations = registrations.filter((r) => !!validCheckinByReg[r.id]);
    } else if (filters.checkin === 'not_checked_in') {
      registrations = registrations.filter((r) => !validCheckinByReg[r.id]);
    } else if (filters.checkin === 'revoked') {
      registrations = registrations.filter((r) => !!revokedCheckinByReg[r.id] && !validCheckinByReg[r.id]);
    }
    if (filters.pairing === 'paired') {
      registrations = registrations.filter((r) => !!activePairByReg[r.id]);
    } else if (filters.pairing === 'waiting') {
      registrations = registrations.filter((r) => !!validCheckinByReg[r.id] && !activePairByReg[r.id]);
    } else if (filters.pairing === 'unpaired') {
      registrations = registrations.filter((r) => !activePairByReg[r.id]);
    }
    if (filters.survey_completion === 'submitted') {
      registrations = registrations.filter((r) => !!submittedByReg[r.id]);
    } else if (filters.survey_completion === 'not_submitted') {
      registrations = registrations.filter((r) => !submittedByReg[r.id]);
    }
    const regIds = registrations.map((r) => r.id);
    const inUniverse = (rid) => regIds.indexOf(rid) >= 0;
    const universeCheckins = checkins.filter((c) => inUniverse(c.get('registration_id')));
    const universePairs = pairs.filter(
      (p) => inUniverse(p.get('speaker_registration_id')) || inUniverse(p.get('listener_registration_id')),
    );
    const universeSubmissions = submissions.filter((s) => inUniverse(s.get('registration_id')));
    return {
      activities,
      registrations,
      checkins: universeCheckins,
      validCheckinByReg,
      pairs: universePairs,
      activePairByReg,
      surveys,
      submissions: universeSubmissions,
      counts: {
        registrations: registrations.length,
        checkins: universeCheckins.length,
        pairings: universePairs.length,
        surveys: universeSubmissions.length,
      },
    };
  };

  try {
    // --- 鉴权：管理员或超级管理员（与旧导出端点一致）---
    let auth = null;
    let role = null;
    try {
      auth = requireAuth(e, 'admin');
      role = 'admin';
    } catch (_) {
      try {
        auth = requireAuth(e, 'super');
        role = 'super';
      } catch (err) {
        return jsonError(e, 401, 'unauthorized', '需要机构管理员或超级管理员登录');
      }
    }

    // 预览限流（只读但有多表查询成本）：per 机构/超管 60 次/小时滑窗
    const rlKey = 'cc_rl|export_preview|' + (role === 'admin' ? auth.get('organization_id') : auth.id);
    const nowSec = Math.floor(Date.now() / 1000);
    const rlKept = ($app.store().get(rlKey) || []).filter((ts) => ts > nowSec - 3600);
    if (rlKept.length >= 60) {
      return jsonError(e, 429, 'TOO_MANY_ATTEMPTS', '预览请求过于频繁，请稍后再试');
    }
    rlKept.push(nowSec);
    $app.store().set(rlKey, rlKept);

    const body = e.requestInfo().body || {};

    // --- 归一化（v2 形状校验；preview 不受理 v1 旧形状）---
    const selection = exportV2NormalizeSelection(body);

    // --- 范围服务端校验（FR-EXP-004）：身份约束在此覆写客户端越权参数 ---
    const scopeResolved = exportV2ResolveScope(
      selection.scope,
      role,
      role === 'admin' ? auth.get('organization_id') : null,
    );
    const activities = scopeResolved.activities;
    const scopeOrgIds = scopeResolved.organizationIds;
    const scopeActivityIds = activities.map((a) => a.id);

    // 归一化后的 selection 落回服务端校验过的范围（管理员忽略客户端 organization_id）
    if (role === 'admin' && selection.scope.type === 'organization') {
      selection.scope = { type: 'organization', organization_id: scopeResolved.orgConstraint, date_range: selection.scope.date_range };
      if (!selection.scope.date_range) delete selection.scope.date_range;
    }

    // --- 判敏（与正式导出同一函数）---
    const analysis = exportV2AnalyzeSelection(selection, scopeOrgIds, scopeActivityIds);

    // --- 预估行数（与正式导出同一行域口径，只回所选数据域）---
    const universe = exportV2BuildUniverse(selection, activities);
    const estimatedRows = {};
    selection.datasets.forEach((d) => {
      estimatedRows[d] = universe.counts[d];
    });

    // --- 权限结果：未知字段/题目 → not_found；敏感+机构未开开关 → sensitive_export_disabled ---
    let permission = { allowed: true };
    if (analysis.unknown.length > 0) {
      permission = { allowed: false, code: 'not_found' };
    } else if (analysis.requiresSensitive && role === 'admin') {
      const org = $app.findRecordById('organizations', auth.get('organization_id'));
      if (!org.get('allow_sensitive_export')) {
        permission = { allowed: false, code: 'sensitive_export_disabled' };
      }
    }

    return e.json(200, {
      contract_version: EXPORT_V2_CONTRACT_VERSION,
      normalized_selection: selection,
      estimated_rows: estimatedRows,
      requires_sensitive_export: analysis.requiresSensitive,
      sensitive_reasons: analysis.reasons,
      permission,
    });
  } catch (err) {
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});
