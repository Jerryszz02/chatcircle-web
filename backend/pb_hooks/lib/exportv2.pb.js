// lib/exportv2.pb.js — 细粒度导出 v2 标准源（归一化 / 判敏 / 行域构建）
//
// 契约（PRD §7、api-design §6、database-design §6.5、冻结契约
// frontend/src/shared/api/accountEvent.ts「细粒度导出」段，版本 2026-08-28.t0-v1）：
// - ExportSelectionV2：schema_version=2，scope / datasets / survey_ids / filters /
//   columns / format / timezone；指定参与者是 filters.participant_ids（行筛选），不是列。
// - 判敏（api-design §6.2）：账号系统列 phone_full、配对表 partner_name、
//   任一 is_sensitive=true 的报名字段（registration_field_defs）或问卷题目
//   （survey_questions）触发 requires_sensitive_export；phone_masked 不触发。
//   禁止按字段名启发式判断，只认 is_sensitive 标记与账号列策略。
// - POST /api/cc/exports/preview 与 POST /api/cc/exports 必须使用同一套
//   归一化 + 判敏函数；正式创建不信任 preview 旧结果或前端布尔值，必须重算。
// - v1 兼容（api-design §6.3）：旧 {scope, include_pii, confirm} 请求归一化为
//   全数据域 + 范围内全字段/题目 + csv_zip 的 v2 selection；scope_json 写
//   StoredExportSelectionV2（source_schema_version=1/2），include_pii 列由
//   服务端判敏结果派生，不信任客户端布尔值。
// - 审计 metadata 只记范围/筛选/机器码/格式，不记完整手机号、姓名或答案值。
//
// ⚠️ 重要集成说明（PocketBase 0.28.4 实测）：JSVM 各 hooks 文件作用域完全隔离，
// 顶层 var/function/const 均不跨文件可见，亦无 ES module import 支持。
// 因此本文件是契约的「标准源」：exports_v2.pb.js（preview）与 exports.pb.js
// （create）各自把所需函数原样内联到 handler 闭包内使用，修改时必须三处同步。

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** v2 数据域（冻结契约 ExportDataset）。 */
var EXPORT_V2_DATASETS = ['registrations', 'checkins', 'pairings', 'surveys'];

/** v2 导出格式（冻结契约 ExportFormat）。 */
var EXPORT_V2_FORMATS = ['xlsx', 'csv_zip'];

/** v2 系统列（冻结契约 ExportSystemColumn）。 */
var EXPORT_V2_SYSTEM_COLUMNS = [
  'participant_id', 'activity_id', 'activity_role', 'registration_status',
  'checked_in_at', 'onsite_code', 'pair_code', 'partner_name',
  'phone_masked', 'phone_full',
];

/** 触发敏感门槛的账号系统列（api-design §6.2）；phone_masked 不在其中。 */
var EXPORT_V2_SENSITIVE_SYSTEM_COLUMNS = ['phone_full', 'partner_name'];

/** 行筛选合法值（冻结契约 ExportFiltersV2）。 */
var EXPORT_V2_CHECKIN_FILTERS = ['any', 'valid', 'not_checked_in', 'revoked'];
var EXPORT_V2_PAIRING_FILTERS = ['any', 'paired', 'waiting', 'unpaired'];
var EXPORT_V2_SURVEY_COMPLETION_FILTERS = ['any', 'submitted', 'not_submitted'];
var EXPORT_V2_ROLES = ['speaker', 'listener'];
var EXPORT_V2_REGISTRATION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

/** 契约版本（与 accountEvent.ts ACCOUNT_EVENT_CONTRACT_VERSION 一致）。 */
var EXPORT_V2_CONTRACT_VERSION = '2026-08-28.t0-v1';

/** v2 导出文件格式版本（写入 manifest；v1 ZIP 为 1.0）。 */
var EXPORT_V2_FORMAT_VERSION = '2.0';

/**
 * 支持的时区表（分钟偏移，固定偏移无 DST）。
 * JSVM 无 IANA 时区库，只承诺这两个业务需要的时区 + UTC±HH:MM 显式偏移；
 * timezone 同时写入 manifest 供复现（PRD §7「导出结果必须带…时区」）。
 */
var EXPORT_V2_TIMEZONES = { 'UTC': 0, 'Asia/Shanghai': 480 };

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 字符串数组参数解析：去重、去空、非数组返回 null（调用方转 400）。 */
function exportV2StringArray(v, maxLen) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out = [];
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string' || v[i] === '') return null;
    if (out.indexOf(v[i]) < 0) out.push(v[i]);
  }
  if (maxLen && out.length > maxLen) return null;
  return out;
}

/** 枚举数组参数解析：每项必须在 allowed 内；非法返回 null。 */
function exportV2EnumArray(v, allowed) {
  const arr = exportV2StringArray(v, 0);
  if (arr === null) return null;
  for (let i = 0; i < arr.length; i++) {
    if (allowed.indexOf(arr[i]) < 0) return null;
  }
  return arr;
}

/**
 * 时区偏移（分钟）。支持 EXPORT_V2_TIMEZONES 命名时区与 UTC±H[:MM] 显式偏移。
 * 非法返回 null。
 */
function exportV2TimezoneOffset(tz) {
  if (typeof tz !== 'string' || tz === '') return null;
  if (tz in EXPORT_V2_TIMEZONES) return EXPORT_V2_TIMEZONES[tz];
  const m = /^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(tz);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const hh = parseInt(m[2], 10);
  const mm = m[3] ? parseInt(m[3], 10) : 0;
  if (hh > 14 || mm > 59) return null;
  return sign * (hh * 60 + mm);
}

/** PB 日期串/ISO 串 → 指定时区的 'YYYY-MM-DD HH:mm:ss±HH:MM'；空值返回 ''。 */
function exportV2FormatTime(value, offsetMinutes) {
  if (!value) return '';
  const d = new Date(String(value).replace(' ', 'T'));
  if (isNaN(d.getTime())) return '';
  const shifted = new Date(d.getTime() + offsetMinutes * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return (
    shifted.getUTCFullYear() + '-' + pad(shifted.getUTCMonth() + 1) + '-' + pad(shifted.getUTCDate()) +
    ' ' + pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes()) + ':' + pad(shifted.getUTCSeconds()) +
    sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
  );
}

// ---------------------------------------------------------------------------
// scope 归一化（v1/v2 共用形状；role 约束在 handler 内按身份另行校验）
// ---------------------------------------------------------------------------

/**
 * 校验并归一化 scope。失败抛 ccError 标记对象（由 handler 顶层 catch 转 400）。
 * @returns {{type:string, organization_id?:string, activity_id?:string, date_range?:{from?:string,to?:string}}}
 */
function exportV2NormalizeScope(scope, ccError) {
  if (!scope || typeof scope !== 'object') {
    ccError(400, 'validation_failed', 'scope 必填');
  }
  const type = scope.type;
  if (['platform', 'organization', 'activity'].indexOf(type) < 0) {
    ccError(400, 'validation_failed', 'scope.type 必须为 platform / organization / activity');
  }
  const out = { type };
  if (type === 'organization') {
    if (scope.organization_id !== undefined && typeof scope.organization_id !== 'string') {
      ccError(400, 'validation_failed', 'scope.organization_id 须为字符串');
    }
    // 管理员的 organization_id 由身份注入，此处仅记录客户端值供超管路径使用
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
}

// ---------------------------------------------------------------------------
// v2 请求体归一化
// ---------------------------------------------------------------------------

/**
 * 归一化 v2 请求体为 ExportSelectionV2。失败抛 ccError。
 * 不做身份范围约束（role/org 由 handler 在解析后校验并覆写 scope）。
 */
function exportV2NormalizeSelection(body, ccError) {
  if (!body || typeof body !== 'object') ccError(400, 'validation_failed', '请求体必填');
  if (body.schema_version !== 2) {
    ccError(400, 'validation_failed', '细粒度导出请求须带 schema_version:2');
  }
  const scope = exportV2NormalizeScope(body.scope, ccError);

  const datasets = exportV2EnumArray(body.datasets, EXPORT_V2_DATASETS);
  if (datasets === null || datasets.length === 0) {
    ccError(400, 'validation_failed', 'datasets 须为 registrations/checkins/pairings/surveys 的非空子集');
  }

  const surveyIds = exportV2StringArray(body.survey_ids, 200);
  if (surveyIds === null) {
    ccError(400, 'validation_failed', 'survey_ids 须为活动问卷 id 数组（≤200）');
  }

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
  const surveyCompletion =
    filtersIn.survey_completion === undefined ? 'any' : filtersIn.survey_completion;
  if (EXPORT_V2_SURVEY_COMPLETION_FILTERS.indexOf(surveyCompletion) < 0) {
    ccError(400, 'validation_failed', 'filters.survey_completion 须为 any/submitted/not_submitted');
  }

  const columnsIn = body.columns || {};
  if (typeof columnsIn !== 'object') ccError(400, 'validation_failed', 'columns 须为对象');
  const systemColumns = exportV2EnumArray(columnsIn.system, EXPORT_V2_SYSTEM_COLUMNS);
  if (systemColumns === null) {
    ccError(400, 'validation_failed', 'columns.system 含非法系统列');
  }
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
  // surveys 数据域未选时不允许选问卷题目（无消费场景）
  if (datasets.indexOf('surveys') < 0 && questionSelections.length > 0) {
    ccError(400, 'validation_failed', '未选 surveys 数据域时不能选择问卷题目列');
  }

  const format = body.format === undefined ? 'xlsx' : body.format;
  if (EXPORT_V2_FORMATS.indexOf(format) < 0) {
    ccError(400, 'validation_failed', 'format 须为 xlsx 或 csv_zip');
  }
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
    columns: {
      system: systemColumns,
      registration_field_codes: fieldCodes,
      survey_questions: questionSelections,
    },
    format,
    timezone,
  };
}

// ---------------------------------------------------------------------------
// 范围解析：身份约束 + 活动集合（v1/v2 共用口径，与旧 exports.pb.js 一致）
// ---------------------------------------------------------------------------

/**
 * 按身份校验并解析范围。返回 { orgConstraint, activities, organizationIds }。
 * - 管理员：仅 organization / activity，机构由身份注入（忽略客户端越权参数，FR-EXP-004）；
 * - 超管：platform / organization（须指定存在的 organization_id）/ activity。
 * 失败抛 ccError（403 scope_forbidden / 400 validation_failed / 404 not_found）。
 */
function exportV2ResolveScope(app, scope, role, authOrgId, queryAll, ccError) {
  const iso = (s) => (s ? String(s).replace(' ', 'T') : '');
  let orgConstraint = null;
  if (role === 'admin') {
    orgConstraint = authOrgId;
    if (scope.type !== 'organization' && scope.type !== 'activity') {
      ccError(403, 'scope_forbidden', '机构管理员仅可导出本机构全部或指定单活动');
    }
  } else {
    if (scope.type === 'organization') {
      if (!scope.organization_id) {
        ccError(400, 'validation_failed', '机构范围导出须指定 scope.organization_id');
      }
      try {
        app.findRecordById('organizations', scope.organization_id);
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
      activity = app.findRecordById('activities', scope.activity_id);
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
  // 时间范围（重叠口径，与看板一致）
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
}

// ---------------------------------------------------------------------------
// 判敏：preview 与 create 共用的唯一判定函数（api-design §6.2）
// ---------------------------------------------------------------------------

/**
 * 解析选择内容并判定敏感性。
 * @param {object} app $app 或 txApp
 * @param {object} selection 归一化后的 ExportSelectionV2
 * @param {string[]} scopeOrgIds 范围内机构 id（标准字段 organization_id='' 恒在范围）
 * @param {string[]} scopeActivityIds 范围内活动 id（校验 survey_questions 归属）
 * @returns {{
 *   requiresSensitive: boolean,
 *   reasons: Array<{source:'account_column'|'registration_field'|'survey_question', code:string}>,
 *   unknown: string[],
 *   fieldDefByCode: Object<string, object>,
 *   questionByKey: Object<string, object>,
 * }}
 */
function exportV2AnalyzeSelection(app, selection, scopeOrgIds, scopeActivityIds) {
  const reasons = [];
  const unknown = [];
  const fieldDefByCode = {};
  const questionByKey = {};
  const pushReason = (source, code) => {
    for (let i = 0; i < reasons.length; i++) {
      if (reasons[i].source === source && reasons[i].code === code) return;
    }
    reasons.push({ source, code });
  };

  // 1) 账号系统列（api-design §6.2；phone_masked 不触发）
  selection.columns.system.forEach((col) => {
    if (EXPORT_V2_SENSITIVE_SYSTEM_COLUMNS.indexOf(col) >= 0) {
      pushReason('account_column', col);
    }
  });

  // 2) 报名字段：按 field_code 在（平台标准 + 范围内机构）定义中解析；
  //    机构自定义与标准同码时以机构定义为准（与报名渲染的覆盖口径一致）
  selection.columns.registration_field_codes.forEach((code) => {
    let def = null;
    const found = app.findRecordsByFilter(
      'registration_field_defs',
      "field_code = {:c} && (organization_id = '' || " + exportV2OrgInClause(scopeOrgIds) + ')',
      '',
      10,
      0,
      { c: code },
    );
    found.forEach((d) => {
      if (d.get('organization_id') !== '') def = d; // 机构定义优先
    });
    if (!def && found.length > 0) def = found[0];
    if (!def) {
      unknown.push('registration_field:' + code);
      return;
    }
    fieldDefByCode[code] = def;
    if (def.get('is_sensitive')) pushReason('registration_field', code);
  });

  // 3) 问卷题目：校验问卷在范围内，题目按 question_code 解析
  selection.columns.survey_questions.forEach((qs) => {
    let survey = null;
    try {
      survey = app.findRecordById('activity_surveys', qs.activity_survey_id);
    } catch (_) {
      survey = null;
    }
    if (!survey || scopeActivityIds.indexOf(survey.get('activity_id')) < 0) {
      unknown.push('survey:' + qs.activity_survey_id);
      return;
    }
    qs.question_codes.forEach((qc) => {
      const found = app.findRecordsByFilter(
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

  return { requiresSensitive: reasons.length > 0, reasons, unknown, fieldDefByCode, questionByKey };
}

/** 机构 id 列表 → "organization_id = '...' || ..." 过滤片段（id 白名单校验；空列表恒假）。 */
function exportV2OrgInClause(orgIds) {
  const parts = [];
  orgIds.forEach((id) => {
    if (!/^[A-Za-z0-9_]+$/.test(id)) return;
    parts.push("organization_id = '" + id + "'");
  });
  // 空列表用不可能命中的字面量 id（PB filter 不接受 1=2 之类的常量表达式）
  return parts.length ? '(' + parts.join(' || ') + ')' : "organization_id = '__no_such_org__'";
}

// ---------------------------------------------------------------------------
// v1 → v2 归一化（api-design §6.3）
// ---------------------------------------------------------------------------

/**
 * 旧 {scope, include_pii, confirm} 请求归一化为 v2 selection：
 * 范围内全数据域 + 范围内全部旧列 + csv_zip。include_pii=false 时只枚举
 * 非敏感字段/题目（与旧导出的实际内容一致，保证派生的 include_pii 准确）；
 * include_pii=true 时枚举全部，并额外记 account_column:username 敏感原因
 * （旧敏感导出 participants.csv 含用户名），由 analyzeLegacyV1 附加。
 */
function exportV2NormalizeLegacy(app, body, scopeOrgIds, scopeActivityIds, ccError) {
  const scope = exportV2NormalizeScope(body.scope || {}, ccError);
  const includePii = body.include_pii === true;

  // 范围内全部报名字段代码（平台标准 + 范围机构；机构同码覆盖标准）
  const fieldDefs = app.findRecordsByFilter(
    'registration_field_defs',
    "(organization_id = '' || " + exportV2OrgInClause(scopeOrgIds) + ')',
    'created',
    500,
    0,
    {},
  );
  const fieldCodeSet = [];
  const orgFieldCodes = {};
  fieldDefs.forEach((d) => {
    if (d.get('organization_id') !== '') orgFieldCodes[d.get('field_code')] = true;
  });
  fieldDefs.forEach((d) => {
    const code = d.get('field_code');
    const isOrg = d.get('organization_id') !== '';
    if (!isOrg && orgFieldCodes[code]) return; // 被机构同码覆盖
    if (!includePii && d.get('is_sensitive')) return; // 旧普通导出按标记排除
    if (fieldCodeSet.indexOf(code) < 0) fieldCodeSet.push(code);
  });

  // 范围内全部问卷题目（按问卷分组；普通导出不枚举敏感题）
  const surveyQuestions = [];
  if (scopeActivityIds.length > 0) {
    const surveys = app.findRecordsByFilter(
      'activity_surveys',
      exportV2ActivityInClause(scopeActivityIds),
      'created',
      500,
      0,
      {},
    );
    surveys.forEach((s) => {
      const questions = app.findRecordsByFilter(
        'survey_questions',
        'activity_survey_id = {:s}',
        'order_index',
        500,
        0,
        { s: s.id },
      );
      const codes = [];
      questions.forEach((q) => {
        if (!includePii && q.get('is_sensitive')) return;
        codes.push(q.get('question_code'));
      });
      if (codes.length > 0) {
        surveyQuestions.push({ activity_survey_id: s.id, question_codes: codes });
      }
    });
  }

  return {
    selection: {
      schema_version: 2,
      scope,
      datasets: EXPORT_V2_DATASETS.slice(),
      survey_ids: [],
      filters: {
        participant_ids: [],
        activity_roles: [],
        registration_statuses: [],
        checkin: 'any',
        pairing: 'any',
        survey_completion: 'any',
      },
      columns: {
        // 旧 ZIP 实际包含的系统列（旧列集无现场/配对/手机号列）
        system: ['participant_id', 'activity_id', 'activity_role', 'registration_status', 'checked_in_at'],
        registration_field_codes: fieldCodeSet,
        survey_questions: surveyQuestions,
      },
      format: 'csv_zip',
      timezone: 'UTC',
    },
    includePii,
  };
}

/** 活动 id 列表 → "activity_id = '...' || ..." 过滤片段（id 白名单校验；空列表恒假）。 */
function exportV2ActivityInClause(activityIds) {
  const parts = [];
  activityIds.forEach((id) => {
    if (!/^[A-Za-z0-9_]+$/.test(id)) return;
    parts.push("activity_id = '" + id + "'");
  });
  return parts.length ? '(' + parts.join(' || ') + ')' : "activity_id = '__no_such_activity__'";
}

/**
 * v1 判敏附加：旧敏感导出 participants.csv 含 username（账号层敏感列，
 * 不在 v2 ExportSystemColumn 枚举内），include_pii=true 时恒记该原因；
 * 字段/题目原因由 exportV2AnalyzeSelection 对归一化 selection 重算给出。
 */
function exportV2LegacyExtraReasons(includePii) {
  return includePii ? [{ source: 'account_column', code: 'username' }] : [];
}

// ---------------------------------------------------------------------------
// 行域构建：preview（计数）与 create（取数）共用的同一过滤口径
// ---------------------------------------------------------------------------

/**
 * 构建导出行域：范围内报名经 filters 过滤后的「行宇宙」，及各数据域记录。
 * 所有过滤口径集中在此，preview 的 estimated_rows 与正式导出文件用同一函数，
 * 保证「先预览后生成」数字一致。
 *
 * @returns {{
 *   activities: object[], registrations: object[], checkins: object[],
 *   validCheckinByReg: Object, pairs: object[], activePairByReg: Object,
 *   surveys: object[], submissions: object[],
 *   counts: {registrations:number, checkins:number, pairings:number, surveys:number},
 * }}
 */
function exportV2BuildUniverse(app, selection, activities, queryAll) {
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
    // 作废答卷不计入导出口径（database-design §5.2.16）
    const clause = [];
    surveyIds.forEach((id) => {
      if (/^[A-Za-z0-9_]+$/.test(id)) clause.push("activity_survey_id = '" + id + "'");
    });
    submissions = queryAll(
      'submissions',
      '(' + clause.join(' || ') + ") && status != 'voided'",
      {},
      'created',
    );
  }

  // --- 报名基础筛选：指定参与者 / 角色 / 报名状态 ---
  if (filters.participant_ids.length > 0) {
    registrations = registrations.filter((r) => filters.participant_ids.indexOf(r.get('participant_id')) >= 0);
  }
  if (filters.activity_roles.length > 0) {
    registrations = registrations.filter((r) => filters.activity_roles.indexOf(r.get('activity_role')) >= 0);
  }
  if (filters.registration_statuses.length > 0) {
    registrations = registrations.filter((r) => filters.registration_statuses.indexOf(r.get('status')) >= 0);
  }

  // --- 派生索引：签到 / 配对 / 答卷 ---
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
  const anySubmissionByReg = {};
  submissions.forEach((s) => {
    anySubmissionByReg[s.get('registration_id')] = true;
    if (s.get('status') === 'submitted') submittedByReg[s.get('registration_id')] = true;
  });

  // --- 行筛选：签到 / 配对 / 问卷完成（作用于报名行宇宙） ---
  if (filters.checkin === 'valid') {
    registrations = registrations.filter((r) => !!validCheckinByReg[r.id]);
  } else if (filters.checkin === 'not_checked_in') {
    registrations = registrations.filter((r) => !validCheckinByReg[r.id]);
  } else if (filters.checkin === 'revoked') {
    // 曾签到但被撤销：有 revoked 记录且当前无有效签到
    registrations = registrations.filter((r) => !!revokedCheckinByReg[r.id] && !validCheckinByReg[r.id]);
  }
  if (filters.pairing === 'paired') {
    registrations = registrations.filter((r) => !!activePairByReg[r.id]);
  } else if (filters.pairing === 'waiting') {
    // 已到待配对：有有效签到但无 active 配对
    registrations = registrations.filter((r) => !!validCheckinByReg[r.id] && !activePairByReg[r.id]);
  } else if (filters.pairing === 'unpaired') {
    registrations = registrations.filter((r) => !activePairByReg[r.id]);
  }
  if (filters.survey_completion === 'submitted') {
    registrations = registrations.filter((r) => !!submittedByReg[r.id]);
  } else if (filters.survey_completion === 'not_submitted') {
    registrations = registrations.filter((r) => !submittedByReg[r.id]);
  }

  // --- 各数据域按行宇宙收敛（同一口径，保证 preview 计数 = 正式行数） ---
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
}
