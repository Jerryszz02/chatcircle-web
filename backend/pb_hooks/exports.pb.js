// Chat Circles — exports.pb.js：导出域 hooks（后端 B）
// 职责（technical-design §5.5、PRD §10、FR-EXP-001~006、AC-16/17、security-privacy §4/§10）：
// - POST /api/cc/exports：范围服务端校验（管理员=本机构全部或指定单活动；超管=全平台/机构/单活动，
//   忽略客户端越权参数，FR-EXP-004）+ 敏感导出开关（机构 allow_sensitive_export，FR-ORG-005）+
//   二次确认（confirm:true，FR-EXP-003）+ 创建限流（per 机构 10 次/小时、per 超管 20 次/小时，
//   滑窗存 $app.store()）+ 审计（普通 export.normal / 敏感 export.sensitive，
//   security-privacy §8.1 数据类）；同步生成 ZIP 并留痕 export_jobs（导出人/范围/时间/
//   是否含个人信息/文件校验信息，PRD §10.3）；job 与审计同事务提交。
// - ZIP 内容（PRD §10.1 全部 CSV 清单）：organizations / activities / participants /
//   registrations / registration_answers / checkins / survey_templates / surveys / submissions /
//   answers / custom_fields / data_dictionary / manifest，共 13 个 CSV。
//   格式规则（PRD §10.3）：UTF-8 BOM、稳定英文列名、ISO 8601 时间（UTC，显式时区）、
//   缺失值用空值、多选答案用标准 JSON 数组。
// - 敏感过滤（FR-EXP-002、AC-16）：普通导出按 is_sensitive 标记排除（registration_field_defs
//   与 survey_questions 两个标记位，禁止按字段名启发式判断）；主体关联用 participant_id，
//   普通导出不导出用户名；作废答卷（status=voided）不计入导出口径（database-design §5.2.16）。
// - GET /api/cc/exports/{id}/download：鉴权下载（管理员仅本机构任务、超管全部），
//   文件存受保护目录（pb_data/exports，非公开静态路径），文件名随机不可猜（FR-EXP-005）；
//   成功下载写审计 export.download。
// - CSV 安全：单元格以 = + - @ 或 Tab 开头的值前置单引号（公式注入防护）。
//
// 实现说明：
// - JSVM 无压缩库，ZIP 采用 store（不压缩）格式手写（本地文件头 + 中央目录 + CRC32）；
//   UTF-8 编码手工实现（JSVM 无 TextEncoder），均已实测字节级往返一致。
// - PocketBase 0.28 JSVM 实测：handler 在请求期以全新作用域执行，文件级函数/常量对 handler
//   不可见，故两个 handler 各自自包含，共享 lib 在 handler 内 require。

// ---------------------------------------------------------------------------
// 端点 1：POST /api/cc/exports — 创建导出任务并同步生成 ZIP
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/exports', (e) => {
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

  const EXPORT_DIR = $app.dataDir() + '/exports'; // 受保护目录（pb_data 内，不挂公开静态路径）
  const EXPORT_FORMAT_VERSION = '1.0';

  // --- 基础工具 ---
  const iso = (s) => (s ? String(s).replace(' ', 'T') : ''); // PB 日期串 → ISO 8601 UTC

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

  // UTF-8 手工编码：字符串 → 字节数组
  const utf8Bytes = (str) => {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let cp = str.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
        const lo = str.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          i++;
        }
      }
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return out;
  };

  const CRC_TABLE = (() => {
    const t = new Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  // 构建 store（不压缩）ZIP；files: [{name, text}]
  const buildZip = (files) => {
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
    const chunks = [];
    const central = [];
    let offset = 0;
    files.forEach((f) => {
      const nameBytes = utf8Bytes(f.name);
      const data = utf8Bytes(f.text);
      const crc = crc32(data);
      const local = []
        .concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate))
        .concat(u32(crc), u32(data.length), u32(data.length))
        .concat(u16(nameBytes.length), u16(0))
        .concat(nameBytes);
      chunks.push(local, data);
      const cen = []
        .concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate))
        .concat(u32(crc), u32(data.length), u32(data.length))
        .concat(u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))
        .concat(nameBytes);
      central.push(cen);
      offset += local.length + data.length;
    });
    let centralSize = 0;
    central.forEach((c) => {
      centralSize += c.length;
    });
    const end = []
      .concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length))
      .concat(u32(centralSize), u32(offset), u16(0));
    const out = [];
    chunks.forEach((c) => out.push(...c));
    central.forEach((c) => out.push(...c));
    out.push(...end);
    return out;
  };

  // CSV 单元格转义；缺失值输出空值（不以 0/-1/"无" 代替，PRD §10.3）；
  // 公式注入防护：以 = + - @ 或 Tab 开头的值前置单引号（Excel/WPS 打开时不解析为公式）
  const csvCell = (v) => {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'object') v = JSON.stringify(v); // 多选答案用标准 JSON 数组（PRD §10.3）
    v = String(v);
    if (/^[=+\-@\t]/.test(v)) v = "'" + v;
    if (/[",\r\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
  };
  // 生成带 UTF-8 BOM 的 CSV 文本
  const buildCsv = (headers, rows) => {
    const lines = [headers.map(csvCell).join(',')];
    rows.forEach((r) => lines.push(r.map(csvCell).join(',')));
    return '﻿' + lines.join('\r\n') + '\r\n';
  };

  // 分页取全量（避免默认页大小截断）
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
  // id 列表构造 'field = {:k0} || ...' 过滤
  const inFilter = (field, ids) => {
    const params = {};
    const parts = ids.map((id, i) => {
      params['k' + i] = id;
      return `${field} = {:k${i}}`;
    });
    return { filter: parts.join(' || '), params };
  };

  // --- 鉴权：管理员或超级管理员（超管不复用机构规则，PRD §12.2）---
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

  // 创建限流（防大批量导出滥用）：per 机构 10 次/小时、per 超管 20 次/小时，
  // 滑窗状态存 $app.store()（JSVM 请求间无共享内存，与 lib/ratelimit.pb.js 同存储约定）
  const rlKey = 'cc_rl|export|' + (role === 'admin' ? auth.get('organization_id') : auth.id);
  const rlMax = role === 'admin' ? 10 : 20;
  const nowSec = Math.floor(Date.now() / 1000);
  const rlKept = ($app.store().get(rlKey) || []).filter((ts) => ts > nowSec - 3600);
  if (rlKept.length >= rlMax) {
    return jsonError(e, 429, 'TOO_MANY_ATTEMPTS', '导出请求过于频繁，请稍后再试');
  }
  rlKept.push(nowSec);
  $app.store().set(rlKey, rlKept);

  const body = e.requestInfo().body || {};
  const scope = body.scope || {};
  const includePii = body.include_pii === true;

  // --- 内联 lib/exportv2.pb.js 标准源（v1→v2 归一化与判敏；与 exports_v2.pb.js 同步，
  //     T6 起 scope_json 存 StoredExportSelectionV2，include_pii 由服务端判敏派生）---
  const EXPORT_V2_SENSITIVE_SYSTEM_COLUMNS = ['phone_full', 'partner_name'];
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
  // 判敏（api-design §6.2）：账号敏感系统列 + is_sensitive 字段/题目；preview 与 create 同一函数
  const exportV2AnalyzeSelection = (selection, scopeOrgIds, scopeActivityIds) => {
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
      found.forEach((d) => {
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
    return { requiresSensitive: reasons.length > 0, reasons, unknown, fieldDefByCode, questionByKey };
  };
  // v1→v2 归一化（api-design §6.3）：全数据域 + 范围内全部旧列 + csv_zip；
  // include_pii=false 只枚举非敏感字段/题目（与旧导出实际内容一致）
  const exportV2NormalizeLegacy = (scopeJson, legacyIncludePii, scopeOrgIds, scopeActivityIds) => {
    const fieldDefs = $app.findRecordsByFilter(
      'registration_field_defs',
      "(organization_id = '' || " + exportV2OrgInClause(scopeOrgIds) + ')',
      'created',
      500,
      0,
      {},
    );
    const orgFieldCodes = {};
    fieldDefs.forEach((d) => {
      if (d.get('organization_id') !== '') orgFieldCodes[d.get('field_code')] = true;
    });
    const fieldCodeSet = [];
    fieldDefs.forEach((d) => {
      const code = d.get('field_code');
      const isOrg = d.get('organization_id') !== '';
      if (!isOrg && orgFieldCodes[code]) return;
      if (!legacyIncludePii && d.get('is_sensitive')) return;
      if (fieldCodeSet.indexOf(code) < 0) fieldCodeSet.push(code);
    });
    const surveyQuestions = [];
    if (scopeActivityIds.length > 0) {
      queryAll('activity_surveys', exportV2ActivityInClause(scopeActivityIds), {}, 'created').forEach((s) => {
        const questions = $app.findRecordsByFilter(
          'survey_questions',
          'activity_survey_id = {:s}',
          'order_index',
          500,
          0,
          { s: s.id },
        );
        const codes = [];
        questions.forEach((q) => {
          if (!legacyIncludePii && q.get('is_sensitive')) return;
          codes.push(q.get('question_code'));
        });
        if (codes.length > 0) surveyQuestions.push({ activity_survey_id: s.id, question_codes: codes });
      });
    }
    const normScope = { type: scopeJson.type };
    if (scopeJson.organization_id) normScope.organization_id = scopeJson.organization_id;
    if (scopeJson.activity_id) normScope.activity_id = scopeJson.activity_id;
    if (scopeJson.date_range) {
      normScope.date_range = {};
      if (scopeJson.date_range.from) normScope.date_range.from = scopeJson.date_range.from;
      if (scopeJson.date_range.to) normScope.date_range.to = scopeJson.date_range.to;
    }
    return {
      schema_version: 2,
      scope: normScope,
      datasets: ['registrations', 'checkins', 'pairings', 'surveys'],
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
        system: ['participant_id', 'activity_id', 'activity_role', 'registration_status', 'checked_in_at'],
        registration_field_codes: fieldCodeSet,
        survey_questions: surveyQuestions,
      },
      format: 'csv_zip',
      timezone: 'UTC',
    };
  };

  // ===== 细粒度导出 v2 分支（schema_version:2，PRD §7 / api-design §6）=====
  // 归一化 + 判敏 + 行域与 preview 端点同一套内联标准源；正式创建重算敏感性，
  // 不信任 preview 旧结果或前端布尔值。
  if (body.schema_version === 2) {
    try {
      const EXPORT_V2_DATASETS = ['registrations', 'checkins', 'pairings', 'surveys'];
      const EXPORT_V2_FORMATS = ['xlsx', 'csv_zip'];
      const EXPORT_V2_SYSTEM_COLUMNS = [
        'participant_id', 'activity_id', 'activity_role', 'registration_status',
        'checked_in_at', 'onsite_code', 'pair_code', 'partner_name',
        'phone_masked', 'phone_full',
      ];
      const EXPORT_V2_CHECKIN_FILTERS = ['any', 'valid', 'not_checked_in', 'revoked'];
      const EXPORT_V2_PAIRING_FILTERS = ['any', 'paired', 'waiting', 'unpaired'];
      const EXPORT_V2_SURVEY_COMPLETION_FILTERS = ['any', 'submitted', 'not_submitted'];
      const EXPORT_V2_ROLES = ['speaker', 'listener'];
      const EXPORT_V2_REGISTRATION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
      const EXPORT_V2_CONTRACT_VERSION = '2026-08-28.t0-v1';
      const EXPORT_V2_FORMAT_VERSION = '2.0';
      const EXPORT_V2_TIMEZONES = { 'UTC': 0, 'Asia/Shanghai': 480 };

      const v2StringArray = (v, maxLen) => {
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
      const v2EnumArray = (v, allowed) => {
        const arr = v2StringArray(v, 0);
        if (arr === null) return null;
        for (let i = 0; i < arr.length; i++) {
          if (allowed.indexOf(arr[i]) < 0) return null;
        }
        return arr;
      };
      const v2TimezoneOffset = (tz) => {
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
      const v2NormalizeSelection = () => {
        if (body.schema_version !== 2) ccError(400, 'validation_failed', '细粒度导出请求须带 schema_version:2');
        const scopeV2 = exportV2NormalizeScopeV2(body.scope);
        const datasets = v2EnumArray(body.datasets, EXPORT_V2_DATASETS);
        if (datasets === null || datasets.length === 0) {
          ccError(400, 'validation_failed', 'datasets 须为 registrations/checkins/pairings/surveys 的非空子集');
        }
        const surveyIds = v2StringArray(body.survey_ids, 200);
        if (surveyIds === null) ccError(400, 'validation_failed', 'survey_ids 须为活动问卷 id 数组（≤200）');
        const filtersIn = body.filters || {};
        if (typeof filtersIn !== 'object') ccError(400, 'validation_failed', 'filters 须为对象');
        const participantIds = v2StringArray(filtersIn.participant_ids, 500);
        if (participantIds === null) {
          ccError(400, 'validation_failed', 'filters.participant_ids 须为参与者 id 数组（≤500）');
        }
        const roles = v2EnumArray(filtersIn.activity_roles, EXPORT_V2_ROLES);
        if (roles === null) ccError(400, 'validation_failed', 'filters.activity_roles 非法');
        const statuses = v2EnumArray(filtersIn.registration_statuses, EXPORT_V2_REGISTRATION_STATUSES);
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
        const systemColumns = v2EnumArray(columnsIn.system, EXPORT_V2_SYSTEM_COLUMNS);
        if (systemColumns === null) ccError(400, 'validation_failed', 'columns.system 含非法系统列');
        const fieldCodes = v2StringArray(columnsIn.registration_field_codes, 200);
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
            const codes = v2StringArray(qs.question_codes, 200);
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
        if (v2TimezoneOffset(timezone) === null) {
          ccError(400, 'validation_failed', 'timezone 仅支持 UTC / Asia/Shanghai / UTC±HH:MM');
        }
        return {
          schema_version: 2,
          scope: scopeV2,
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
      };
      const exportV2NormalizeScopeV2 = (scopeV2raw) => {
        if (!scopeV2raw || typeof scopeV2raw !== 'object') ccError(400, 'validation_failed', 'scope 必填');
        const typeV2 = scopeV2raw.type;
        if (['platform', 'organization', 'activity'].indexOf(typeV2) < 0) {
          ccError(400, 'validation_failed', 'scope.type 必须为 platform / organization / activity');
        }
        const outScope = { type: typeV2 };
        if (typeV2 === 'organization') {
          if (scopeV2raw.organization_id !== undefined && typeof scopeV2raw.organization_id !== 'string') {
            ccError(400, 'validation_failed', 'scope.organization_id 须为字符串');
          }
          if (scopeV2raw.organization_id) outScope.organization_id = scopeV2raw.organization_id;
        }
        if (typeV2 === 'activity') {
          if (!scopeV2raw.activity_id || typeof scopeV2raw.activity_id !== 'string') {
            ccError(400, 'validation_failed', '单活动导出须指定 scope.activity_id');
          }
          outScope.activity_id = scopeV2raw.activity_id;
        }
        const DATE_RE_V2 = /^\d{4}-\d{2}-\d{2}$/;
        const dr = scopeV2raw.date_range || {};
        if (dr.from !== undefined && (typeof dr.from !== 'string' || !DATE_RE_V2.test(dr.from))) {
          ccError(400, 'validation_failed', 'scope.date_range.from 须为 YYYY-MM-DD 格式');
        }
        if (dr.to !== undefined && (typeof dr.to !== 'string' || !DATE_RE_V2.test(dr.to))) {
          ccError(400, 'validation_failed', 'scope.date_range.to 须为 YYYY-MM-DD 格式');
        }
        if (dr.from || dr.to) outScope.date_range = { from: dr.from || undefined, to: dr.to || undefined };
        return outScope;
      };
      const exportV2ResolveScopeV2 = (scopeV2) => {
        let orgConstraintV2 = null;
        if (role === 'admin') {
          orgConstraintV2 = auth.get('organization_id');
          if (scopeV2.type !== 'organization' && scopeV2.type !== 'activity') {
            ccError(403, 'scope_forbidden', '机构管理员仅可导出本机构全部或指定单活动');
          }
        } else if (scopeV2.type === 'organization') {
          if (!scopeV2.organization_id) ccError(400, 'validation_failed', '机构范围导出须指定 scope.organization_id');
          try {
            $app.findRecordById('organizations', scopeV2.organization_id);
          } catch (_) {
            ccError(400, 'validation_failed', 'scope.organization_id 无效');
          }
          orgConstraintV2 = scopeV2.organization_id;
        }
        let acts;
        if (scopeV2.type === 'activity') {
          let activity;
          try {
            activity = $app.findRecordById('activities', scopeV2.activity_id);
          } catch (_) {
            ccError(404, 'not_found', '活动不存在');
          }
          if (orgConstraintV2 && activity.get('organization_id') !== orgConstraintV2) {
            ccError(403, 'scope_forbidden', '无权导出其他机构的活动');
          }
          acts = [activity];
        } else if (orgConstraintV2) {
          acts = queryAll('activities', 'organization_id = {:o}', { o: orgConstraintV2 }, 'created');
        } else {
          acts = queryAll('activities', '', {}, 'created');
        }
        const dr = scopeV2.date_range || {};
        if (dr.from) {
          acts = acts.filter((a) => (iso(a.get('end_time')) || iso(a.get('start_time'))) >= dr.from);
        }
        if (dr.to) {
          acts = acts.filter((a) => iso(a.get('start_time')) <= dr.to + 'T23:59:59.999Z');
        }
        const orgIds = [];
        acts.forEach((a) => {
          const o = a.get('organization_id');
          if (orgIds.indexOf(o) < 0) orgIds.push(o);
        });
        return { orgConstraint: orgConstraintV2, activities: acts, organizationIds: orgIds };
      };
      const exportV2BuildUniverseV2 = (selection, acts) => {
        const filters = selection.filters;
        const actIds = acts.map((a) => a.id);
        const emptyU = {
          registrations: [], checkins: [], validCheckinByReg: {}, pairs: [], activePairByReg: {},
          surveys: [], submissions: [],
          counts: { registrations: 0, checkins: 0, pairings: 0, surveys: 0 },
        };
        if (actIds.length === 0) return emptyU;
        const actClause = exportV2ActivityInClause(actIds);
        let regs = queryAll('registrations', actClause, {}, 'created');
        const allCheckins = queryAll('checkins', actClause, {}, 'created');
        const allPairs = queryAll('activity_pairs', actClause, {}, 'pair_sequence');
        let svs = queryAll('activity_surveys', actClause, {}, 'created');
        if (selection.survey_ids.length > 0) {
          svs = svs.filter((s) => selection.survey_ids.indexOf(s.id) >= 0);
        }
        const svIds = svs.map((s) => s.id);
        let subs = [];
        if (svIds.length > 0) {
          const clause = [];
          svIds.forEach((id) => {
            if (/^[A-Za-z0-9_]+$/.test(id)) clause.push("activity_survey_id = '" + id + "'");
          });
          // 作废答卷不计入导出口径（database-design §5.2.16）
          subs = queryAll('submissions', '(' + clause.join(' || ') + ") && status != 'voided'", {}, 'created');
        }
        if (filters.participant_ids.length > 0) {
          regs = regs.filter((r) => filters.participant_ids.indexOf(r.get('participant_id')) >= 0);
        }
        if (filters.activity_roles.length > 0) {
          regs = regs.filter((r) => filters.activity_roles.indexOf(r.get('activity_role')) >= 0);
        }
        if (filters.registration_statuses.length > 0) {
          regs = regs.filter((r) => filters.registration_statuses.indexOf(r.get('status')) >= 0);
        }
        const validCk = {};
        const revokedCk = {};
        allCheckins.forEach((c) => {
          if (c.get('status') === 'valid') validCk[c.get('registration_id')] = c;
          if (c.get('status') === 'revoked') revokedCk[c.get('registration_id')] = c;
        });
        const activePair = {};
        allPairs.forEach((p) => {
          if (p.get('status') !== 'active') return;
          activePair[p.get('speaker_registration_id')] = p;
          activePair[p.get('listener_registration_id')] = p;
        });
        const submittedByReg = {};
        subs.forEach((s) => {
          if (s.get('status') === 'submitted') submittedByReg[s.get('registration_id')] = true;
        });
        if (filters.checkin === 'valid') {
          regs = regs.filter((r) => !!validCk[r.id]);
        } else if (filters.checkin === 'not_checked_in') {
          regs = regs.filter((r) => !validCk[r.id]);
        } else if (filters.checkin === 'revoked') {
          regs = regs.filter((r) => !!revokedCk[r.id] && !validCk[r.id]);
        }
        if (filters.pairing === 'paired') {
          regs = regs.filter((r) => !!activePair[r.id]);
        } else if (filters.pairing === 'waiting') {
          regs = regs.filter((r) => !!validCk[r.id] && !activePair[r.id]);
        } else if (filters.pairing === 'unpaired') {
          regs = regs.filter((r) => !activePair[r.id]);
        }
        if (filters.survey_completion === 'submitted') {
          regs = regs.filter((r) => !!submittedByReg[r.id]);
        } else if (filters.survey_completion === 'not_submitted') {
          regs = regs.filter((r) => !submittedByReg[r.id]);
        }
        const regIds = regs.map((r) => r.id);
        const inU = (rid) => regIds.indexOf(rid) >= 0;
        const uCheckins = allCheckins.filter((c) => inU(c.get('registration_id')));
        const uPairs = allPairs.filter(
          (p) => inU(p.get('speaker_registration_id')) || inU(p.get('listener_registration_id')),
        );
        const uSubs = subs.filter((s) => inU(s.get('registration_id')));
        return {
          registrations: regs,
          checkins: uCheckins,
          validCheckinByReg: validCk,
          pairs: uPairs,
          activePairByReg: activePair,
          surveys: svs,
          submissions: uSubs,
          counts: {
            registrations: regs.length,
            checkins: uCheckins.length,
            pairings: uPairs.length,
            surveys: uSubs.length,
          },
        };
      };
      // 时间渲染：PB 日期串 → 导出时区 'YYYY-MM-DD HH:mm:ss±HH:MM'
      const v2FormatTime = (value, offsetMinutes) => {
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
      };
      const onsiteCodeOf = (c) => {
        if (!c) return '';
        const letter = c.get('onsite_role') === 'speaker' ? 'S' : c.get('onsite_role') === 'listener' ? 'L' : '';
        const seq = c.get('onsite_sequence');
        if (!letter || !seq) return '';
        return letter + String(seq).padStart(2, '0');
      };
      const pairCodeOf = (p) => 'P' + String(p.get('pair_sequence')).padStart(2, '0');
      const maskPhone = (e164) => {
        if (!e164) return '';
        const s = String(e164);
        if (s.indexOf('+86') === 0 && s.length === 14) return '+86 ' + s.slice(3, 6) + '****' + s.slice(10);
        if (s.length > 6) return s.slice(0, 4) + '****' + s.slice(-2);
        return '****';
      };
      // XML 安全：转义 + 剔除 XML 1.0 非法控制字符（保留合法代理项对）
      const xmlSafe = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        let out = '';
        for (let i = 0; i < s.length; i++) {
          const c = s.charCodeAt(i);
          if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 0xd800) || (c >= 0xe000 && c < 0xfffe)) {
            out += s[i];
            continue;
          }
          if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            const lo = s.charCodeAt(i + 1);
            if (lo >= 0xdc00 && lo <= 0xdfff) {
              out += s[i] + s[i + 1];
              i++;
            }
          }
        }
        return out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      };
      const colName = (idx) => {
        let n = idx + 1;
        let s = '';
        while (n > 0) {
          const m = (n - 1) % 26;
          s = String.fromCharCode(65 + m) + s;
          n = Math.floor((n - 1) / 26);
        }
        return s;
      };
      const buildSheetXml = (rows) => {
        let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
        rows.forEach((row, ri) => {
          xml += '<row r="' + (ri + 1) + '">';
          row.forEach((cell, ci) => {
            if (cell === null || cell === undefined || cell === '') return;
            const ref = colName(ci) + (ri + 1);
            if (typeof cell === 'number' && isFinite(cell)) {
              xml += '<c r="' + ref + '"><v>' + cell + '</v></c>';
            } else {
              xml += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlSafe(cell) + '</t></is></c>';
            }
          });
          xml += '</row>';
        });
        return xml + '</sheetData></worksheet>';
      };
      // 手写最小 XLSX（OOXML 电子表格 = ZIP 内一组 XML；JSVM 无三方库，复用 buildZip）
      const buildXlsx = (sheets) => {
        const used = [];
        const names = sheets.map((sh, i) => {
          let n = String(sh.name).replace(/[\\/*?\[\]:]/g, '_').slice(0, 31) || ('sheet' + (i + 1));
          const baseN = n;
          let k = 1;
          while (used.indexOf(n) >= 0) {
            n = baseN.slice(0, 28) + '_' + k;
            k++;
          }
          used.push(n);
          return n;
        });
        let contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
        names.forEach((_, i) => {
          contentTypes += '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ' +
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
        });
        contentTypes += '</Types>';
        let workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';
        names.forEach((n, i) => {
          workbook += '<sheet name="' + xmlSafe(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
        });
        workbook += '</sheets></workbook>';
        let wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
        names.forEach((_, i) => {
          wbRels += '<Relationship Id="rId' + (i + 1) + '" ' +
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
            'Target="worksheets/sheet' + (i + 1) + '.xml"/>';
        });
        wbRels += '</Relationships>';
        const files = [
          { name: '[Content_Types].xml', text: contentTypes },
          {
            name: '_rels/.rels',
            text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
              '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
              '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
              '</Relationships>',
          },
          { name: 'xl/workbook.xml', text: workbook },
          { name: 'xl/_rels/workbook.xml.rels', text: wbRels },
        ];
        sheets.forEach((sh, i) => {
          files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', text: buildSheetXml(sh.rows) });
        });
        return buildZip(files);
      };

      const selection = v2NormalizeSelection();
      const scopeResolved = exportV2ResolveScopeV2(selection.scope);
      // 管理员的机构范围由身份注入，忽略客户端越权参数（FR-EXP-004）
      if (role === 'admin' && selection.scope.type === 'organization') {
        selection.scope.organization_id = scopeResolved.orgConstraint;
      }
      const v2activities = scopeResolved.activities;
      const v2OrgIds = scopeResolved.organizationIds;
      const v2ActivityIds = v2activities.map((a) => a.id);

      // 判敏（与 preview 同一函数）；未知代码直接 400
      const analysis = exportV2AnalyzeSelection(selection, v2OrgIds, v2ActivityIds);
      if (analysis.unknown.length > 0) {
        ccError(400, 'validation_failed', '存在未知字段/题目/问卷代码：' + analysis.unknown.join('、'));
      }
      // 敏感导出：二次确认（confirm_sensitive:true）+ 机构开关（FR-EXP-003、AC-17）
      if (analysis.requiresSensitive) {
        if (body.confirm_sensitive !== true) {
          ccError(400, 'confirm_required', '敏感导出需要显式确认（confirm_sensitive:true）');
        }
        if (role === 'admin') {
          const org = $app.findRecordById('organizations', auth.get('organization_id'));
          if (!org.get('allow_sensitive_export')) {
            ccError(403, 'sensitive_export_disabled', '本机构未开启敏感导出开关');
          }
        }
      }

      const universe = exportV2BuildUniverseV2(selection, v2activities);
      const tzOffset = v2TimezoneOffset(selection.timezone);
      const fmtT = (v) => v2FormatTime(v, tzOffset);
      const sysCols = selection.columns.system;

      // --- 取值辅助索引 ---
      const allScopeRegs = queryAll('registrations', exportV2ActivityInClause(v2ActivityIds), {}, 'created');
      const regById = {};
      allScopeRegs.forEach((r) => {
        regById[r.id] = r;
      });
      // 搭档姓名只取自该场报名的 FULL_NAME（不从账号层复用，与配对快照同口径）
      let fullNameDefId = '';
      if (sysCols.indexOf('partner_name') >= 0) {
        const fnd = $app.findRecordsByFilter(
          'registration_field_defs',
          "field_code = 'FULL_NAME' && (organization_id = '' || " + exportV2OrgInClause(v2OrgIds) + ')',
          '',
          10,
          0,
          {},
        );
        fnd.forEach((d) => {
          if (d.get('organization_id') !== '') fullNameDefId = d.id;
        });
        if (!fullNameDefId && fnd.length > 0) fullNameDefId = fnd[0].id;
      }
      const fullNameByReg = {};
      if (fullNameDefId && allScopeRegs.length > 0) {
        const fna = inFilter('registration_id', allScopeRegs.map((r) => r.id));
        queryAll(
          'registration_answers',
          '(' + fna.filter + ') && field_def_id = {:fd}',
          Object.assign({}, fna.params, { fd: fullNameDefId }),
          'created',
        ).forEach((a) => {
          fullNameByReg[a.get('registration_id')] = decodeJson(a.get('value_json'));
        });
      }
      // 手机号列仅在选择时加载账号（account 层 phone_e164；masked/full 两档）
      const accountById = {};
      if (sysCols.indexOf('phone_masked') >= 0 || sysCols.indexOf('phone_full') >= 0) {
        const pids = [];
        universe.registrations.forEach((r) => {
          const pid = r.get('participant_id');
          if (pids.indexOf(pid) < 0) pids.push(pid);
        });
        pids.forEach((pid) => {
          try {
            accountById[pid] = $app.findRecordById('participant_accounts', pid);
          } catch (_) {
            /* 账号缺失时留空 */
          }
        });
      }
      // 报名答案：仅取所选字段代码
      const regAnswerMap = {};
      if (selection.columns.registration_field_codes.length > 0 && universe.registrations.length > 0) {
        const defIdToCode = {};
        Object.keys(analysis.fieldDefByCode).forEach((code) => {
          defIdToCode[analysis.fieldDefByCode[code].id] = code;
        });
        const f = inFilter('registration_id', universe.registrations.map((r) => r.id));
        queryAll('registration_answers', f.filter, f.params, 'created').forEach((a) => {
          const code = defIdToCode[a.get('field_def_id')];
          if (!code) return;
          (regAnswerMap[a.get('registration_id')] = regAnswerMap[a.get('registration_id')] || {})[code] =
            decodeJson(a.get('value_json'));
        });
      }

      // --- 组装数据表（{name, headers, rows, dict}；xlsx=逐表 sheet，csv_zip=逐表 CSV）---
      const SYSTEM_COL_DESC = {
        participant_id: ['参与者 ID（跨表关联键）', 'no'],
        activity_id: ['活动 ID', 'no'],
        activity_role: ['活动内角色（speaker=倾诉者, listener=聆听者）', 'no'],
        registration_status: ['报名状态（pending/approved/rejected/cancelled）', 'no'],
        checked_in_at: ['有效签到时间（导出时区）', 'no'],
        onsite_code: ['现场编号（S/L+序号；发出后不复用）', 'no'],
        pair_code: ['配对编号（P+序号）', 'no'],
        partner_name: ['搭档姓名（取自搭档当场报名 FULL_NAME，敏感）', 'yes'],
        phone_masked: ['掩码手机号（现场联系用）', 'no'],
        phone_full: ['完整手机号（敏感）', 'yes'],
      };
      const tables = [];

      if (selection.datasets.indexOf('registrations') >= 0) {
        const headers = ['registration_id'].concat(sysCols).concat(selection.columns.registration_field_codes);
        const dict = [{ column: 'registration_id', description: '报名 ID（参与者×活动唯一）', sensitive: 'no' }];
        sysCols.forEach((col) => {
          const d = SYSTEM_COL_DESC[col] || [col, 'no'];
          dict.push({ column: col, description: d[0], sensitive: d[1] });
        });
        selection.columns.registration_field_codes.forEach((code) => {
          const def = analysis.fieldDefByCode[code];
          dict.push({
            column: code,
            description: '报名字段「' + (def ? def.get('label') : code) + '」',
            sensitive: def && def.get('is_sensitive') ? 'yes' : 'no',
          });
        });
        const rows = universe.registrations.map((r) => {
          const vc = universe.validCheckinByReg[r.id];
          const pair = universe.activePairByReg[r.id];
          const account = accountById[r.get('participant_id')];
          const row = [r.id];
          sysCols.forEach((col) => {
            if (col === 'participant_id') row.push(r.get('participant_id'));
            else if (col === 'activity_id') row.push(r.get('activity_id'));
            else if (col === 'activity_role') row.push(r.get('activity_role'));
            else if (col === 'registration_status') row.push(r.get('status'));
            else if (col === 'checked_in_at') row.push(vc ? fmtT(vc.get('checked_in_at')) : '');
            else if (col === 'onsite_code') row.push(onsiteCodeOf(vc));
            else if (col === 'pair_code') row.push(pair ? pairCodeOf(pair) : '');
            else if (col === 'partner_name') {
              if (!pair) {
                row.push('');
              } else {
                const partnerRegId =
                  pair.get('speaker_registration_id') === r.id
                    ? pair.get('listener_registration_id')
                    : pair.get('speaker_registration_id');
                row.push(fullNameByReg[partnerRegId] || '');
              }
            } else if (col === 'phone_masked') row.push(account ? maskPhone(account.get('phone_e164')) : '');
            else if (col === 'phone_full') row.push(account ? account.get('phone_e164') || '' : '');
          });
          selection.columns.registration_field_codes.forEach((code) => {
            const m = regAnswerMap[r.id] || {};
            const v = m[code];
            row.push(v === null || v === undefined ? '' : v);
          });
          return row;
        });
        tables.push({ name: 'registrations', headers, rows, dict });
      }

      if (selection.datasets.indexOf('checkins') >= 0) {
        const headers = [
          'checkin_id', 'registration_id', 'participant_id', 'activity_id', 'source', 'status',
          'checked_in_at', 'onsite_role', 'onsite_code', 'revoked_at', 'reason',
        ];
        const dict = [
          { column: 'checkin_id', description: '签到记录 ID', sensitive: 'no' },
          { column: 'registration_id', description: '报名 ID', sensitive: 'no' },
          { column: 'participant_id', description: '参与者 ID', sensitive: 'no' },
          { column: 'activity_id', description: '活动 ID', sensitive: 'no' },
          { column: 'source', description: '签到来源（self_scan=自助扫码, manual=管理员补签）', sensitive: 'no' },
          { column: 'status', description: '签到状态（valid=有效, revoked=已撤销）', sensitive: 'no' },
          { column: 'checked_in_at', description: '签到时间（导出时区）', sensitive: 'no' },
          { column: 'onsite_role', description: '现场角色（speaker/listener）', sensitive: 'no' },
          { column: 'onsite_code', description: '现场编号（S/L+序号）', sensitive: 'no' },
          { column: 'revoked_at', description: '撤销时间（导出时区）', sensitive: 'no' },
          { column: 'reason', description: '补签/撤销原因', sensitive: 'no' },
        ];
        const rows = universe.checkins.map((c) => [
          c.id, c.get('registration_id'), c.get('participant_id'), c.get('activity_id'),
          c.get('source'), c.get('status'), fmtT(c.get('checked_in_at')),
          c.get('onsite_role') || '', onsiteCodeOf(c), fmtT(c.get('revoked_at')), c.get('reason') || '',
        ]);
        tables.push({ name: 'checkins', headers, rows, dict });
      }

      if (selection.datasets.indexOf('pairings') >= 0) {
        const withNames = sysCols.indexOf('partner_name') >= 0;
        const headers = [
          'pair_id', 'activity_id', 'pair_code', 'status',
          'speaker_registration_id', 'speaker_participant_id', 'speaker_onsite_code',
          'listener_registration_id', 'listener_participant_id', 'listener_onsite_code',
          'paired_at', 'released_at', 'completed_at', 'adjustment_reason', 'release_reason',
        ];
        if (withNames) headers.push('speaker_name', 'listener_name');
        const dict = [
          { column: 'pair_id', description: '配对记录 ID', sensitive: 'no' },
          { column: 'activity_id', description: '活动 ID', sensitive: 'no' },
          { column: 'pair_code', description: '配对编号（P+序号）', sensitive: 'no' },
          { column: 'status', description: '配对状态（active/released/completed）', sensitive: 'no' },
          { column: 'speaker_registration_id', description: '倾诉者报名 ID', sensitive: 'no' },
          { column: 'speaker_participant_id', description: '倾诉者参与者 ID', sensitive: 'no' },
          { column: 'speaker_onsite_code', description: '倾诉者现场编号', sensitive: 'no' },
          { column: 'listener_registration_id', description: '聆听者报名 ID', sensitive: 'no' },
          { column: 'listener_participant_id', description: '聆听者参与者 ID', sensitive: 'no' },
          { column: 'listener_onsite_code', description: '聆听者现场编号', sensitive: 'no' },
          { column: 'paired_at', description: '配对时间（导出时区）', sensitive: 'no' },
          { column: 'released_at', description: '释放时间', sensitive: 'no' },
          { column: 'completed_at', description: '完成时间', sensitive: 'no' },
          { column: 'adjustment_reason', description: '手工调整原因', sensitive: 'no' },
          { column: 'release_reason', description: '释放原因', sensitive: 'no' },
        ];
        if (withNames) {
          dict.push({ column: 'speaker_name', description: '倾诉者姓名（当场报名 FULL_NAME，敏感）', sensitive: 'yes' });
          dict.push({ column: 'listener_name', description: '聆听者姓名（当场报名 FULL_NAME，敏感）', sensitive: 'yes' });
        }
        const rows = universe.pairs.map((p) => {
          const spReg = regById[p.get('speaker_registration_id')];
          const liReg = regById[p.get('listener_registration_id')];
          let spCk = null;
          let liCk = null;
          try {
            spCk = $app.findRecordById('checkins', p.get('speaker_checkin_id'));
          } catch (_) {
            /* 签到记录缺失时留空 */
          }
          try {
            liCk = $app.findRecordById('checkins', p.get('listener_checkin_id'));
          } catch (_) {
            /* 同上 */
          }
          const row = [
            p.id, p.get('activity_id'), pairCodeOf(p), p.get('status'),
            p.get('speaker_registration_id'), spReg ? spReg.get('participant_id') : '', onsiteCodeOf(spCk),
            p.get('listener_registration_id'), liReg ? liReg.get('participant_id') : '', onsiteCodeOf(liCk),
            fmtT(p.get('paired_at')), fmtT(p.get('released_at')), fmtT(p.get('completed_at')),
            p.get('adjustment_reason') || '', p.get('release_reason') || '',
          ];
          if (withNames) {
            row.push(fullNameByReg[p.get('speaker_registration_id')] || '');
            row.push(fullNameByReg[p.get('listener_registration_id')] || '');
          }
          return row;
        });
        tables.push({ name: 'pairings', headers, rows, dict });
      }

      if (selection.datasets.indexOf('surveys') >= 0) {
        const selectedBySurvey = {};
        selection.columns.survey_questions.forEach((qs) => {
          selectedBySurvey[qs.activity_survey_id] = qs.question_codes;
        });
        universe.surveys.forEach((sv) => {
          const qcodes = selectedBySurvey[sv.id] || [];
          const subs = universe.submissions.filter((s) => s.get('activity_survey_id') === sv.id);
          const ansMap = {};
          if (qcodes.length > 0 && subs.length > 0) {
            const f = inFilter('submission_id', subs.map((s) => s.id));
            queryAll('answers', f.filter, f.params, 'created').forEach((a) => {
              ansMap[a.get('submission_id') + ':' + a.get('question_code')] = decodeJson(a.get('value_json'));
            });
          }
          const headers = ['submission_id', 'registration_id', 'participant_id', 'activity_id', 'status', 'submitted_at']
            .concat(qcodes);
          const dict = [
            { column: 'submission_id', description: '答卷 ID', sensitive: 'no' },
            { column: 'registration_id', description: '报名 ID', sensitive: 'no' },
            { column: 'participant_id', description: '参与者 ID', sensitive: 'no' },
            { column: 'activity_id', description: '活动 ID', sensitive: 'no' },
            { column: 'status', description: '答卷状态（draft/submitted；作废已排除）', sensitive: 'no' },
            { column: 'submitted_at', description: '正式提交时间（导出时区）', sensitive: 'no' },
          ];
          qcodes.forEach((qc) => {
            const q = analysis.questionByKey[sv.id + ':' + qc];
            dict.push({
              column: qc,
              description: '问卷题目「' + (q ? q.get('title') : qc) + '」',
              sensitive: q && q.get('is_sensitive') ? 'yes' : 'no',
            });
          });
          const rows = subs.map((s) => {
            const row = [
              s.id, s.get('registration_id'), s.get('participant_id'), sv.get('activity_id'),
              s.get('status'), fmtT(s.get('submitted_at')),
            ];
            qcodes.forEach((qc) => {
              const v = ansMap[s.id + ':' + qc];
              row.push(v === null || v === undefined ? '' : v);
            });
            return row;
          });
          tables.push({ name: 'survey_' + sv.get('survey_code'), headers, rows, dict });
        });
      }

      // data_dictionary：字段说明与敏感标记（下游可复现过滤口径，AC-16）
      const dictRows = [];
      tables.forEach((t) => {
        t.dict.forEach((d) => {
          dictRows.push([t.name, d.column, d.description, d.sensitive]);
        });
      });
      dictRows.push(['manifest', 'key', '清单项', 'no']);
      dictRows.push(['manifest', 'value', '清单值', 'no']);
      tables.push({
        name: 'data_dictionary',
        headers: ['table', 'column', 'description', 'is_sensitive'],
        rows: dictRows,
        dict: [],
      });

      // manifest：筛选摘要、字段清单、生成时间与时区（PRD §7「导出结果必须带…确保可复现」）
      const manifestRows = [
        ['export_format_version', EXPORT_V2_FORMAT_VERSION],
        ['contract_version', EXPORT_V2_CONTRACT_VERSION],
        ['generated_at', new Date().toISOString()],
        ['timezone', selection.timezone],
        ['scope_type', selection.scope.type],
        ['scope_organization_id', selection.scope.organization_id || ''],
        ['scope_activity_id', selection.scope.activity_id || ''],
        ['scope_date_from', (selection.scope.date_range && selection.scope.date_range.from) || ''],
        ['scope_date_to', (selection.scope.date_range && selection.scope.date_range.to) || ''],
        ['datasets', selection.datasets.join(';')],
        ['survey_ids', selection.survey_ids.join(';')],
        ['format', selection.format],
        ['filters', JSON.stringify(selection.filters)],
        ['system_columns', sysCols.join(';')],
        ['registration_field_codes', selection.columns.registration_field_codes.join(';')],
        [
          'survey_questions',
          selection.columns.survey_questions
            .map((qs) => qs.activity_survey_id + ':' + qs.question_codes.join(','))
            .join(';'),
        ],
        ['requires_sensitive_export', String(analysis.requiresSensitive)],
        [
          'sensitive_reasons',
          analysis.reasons.map((r) => r.source + ':' + r.code).join(';'),
        ],
        ['source_schema_version', '2'],
        ['created_by', auth.id],
        ['voided_submissions_excluded', 'yes'],
      ];
      tables.forEach((t) => {
        manifestRows.push(['rows.' + t.name, String(t.rows.length)]);
      });
      tables.push({ name: 'manifest', headers: ['key', 'value'], rows: manifestRows, dict: [] });

      // --- 渲染：xlsx=多 sheet 工作簿；csv_zip=每表一个 CSV（UTF-8 BOM + 公式注入防护）---
      let outBytes;
      let outExt;
      try {
        if (selection.format === 'xlsx') {
          outBytes = buildXlsx(tables.map((t) => ({ name: t.name, rows: [t.headers].concat(t.rows) })));
          outExt = 'xlsx';
        } else {
          outBytes = buildZip(tables.map((t) => ({ name: t.name + '.csv', text: buildCsv(t.headers, t.rows) })));
          outExt = 'zip';
        }
      } catch (err) {
        ccError(500, 'internal_error', '导出文件渲染失败：' + String(err));
      }

      // --- 写文件 + job + 审计（同事务；审计只记机器码不记敏感值）---
      const storedSelection = Object.assign({}, selection, { source_schema_version: 2 });
      let fileName2;
      let checksum2;
      let genError2 = null;
      try {
        fileName2 = 'cc_export_' + $security.randomString(24) + '.' + outExt;
        checksum2 = $security.sha256(outBytes);
        $os.mkdirAll(EXPORT_DIR, 0o700);
        $os.writeFile(EXPORT_DIR + '/' + fileName2, outBytes, 0o600);
      } catch (err) {
        genError2 = err;
      }
      const jobOrg = scopeResolved.orgConstraint;
      let job2 = null;
      $app.runInTransaction((txApp) => {
        const jobsCol = txApp.findCollectionByNameOrId('export_jobs');
        job2 = new Record(jobsCol);
        if (jobOrg) job2.set('organization_id', jobOrg);
        job2.set('scope_json', storedSelection);
        job2.set('include_pii', analysis.requiresSensitive);
        job2.set('file_path', genError2 ? '-' : EXPORT_DIR + '/' + fileName2);
        job2.set('file_checksum', genError2 ? '' : checksum2);
        job2.set('status', genError2 ? 'failed' : 'done');
        job2.set('created_by', auth.id);
        txApp.save(job2);
        writeAudit(txApp, {
          actorId: auth.id,
          actorRole: role === 'admin' ? 'admin' : 'super_admin',
          organizationId: jobOrg || undefined,
          action: analysis.requiresSensitive ? 'export.sensitive' : 'export.normal',
          targetType: 'export_job',
          targetId: job2.id,
          result: genError2 ? 'failure' : 'success',
          metadata: {
            schema_version: 2,
            source_schema_version: 2,
            scope: storedSelection.scope,
            datasets: storedSelection.datasets,
            format: storedSelection.format,
            timezone: storedSelection.timezone,
            filters: storedSelection.filters,
            system_columns: storedSelection.columns.system,
            field_codes: storedSelection.columns.registration_field_codes,
            survey_questions: storedSelection.columns.survey_questions,
            requires_sensitive_export: analysis.requiresSensitive,
            sensitive_reasons: analysis.reasons,
            confirm_sensitive: body.confirm_sensitive === true,
            activity_count: v2activities.length,
            row_counts: universe.counts,
            error: genError2 ? String(genError2) : undefined,
          },
        });
      });
      if (genError2) {
        return jsonError(e, 500, 'internal_error', '导出文件生成失败，请稍后重试');
      }
      // 契约 CreateExportV2Response：status 恒为 'running'（冻结契约字面量；
      // 本实现同步生成，实际状态以下载端点/job 记录为准）
      return e.json(200, {
        contract_version: EXPORT_V2_CONTRACT_VERSION,
        export_job_id: job2.id,
        status: 'running',
        requires_sensitive_export: analysis.requiresSensitive,
        normalized_selection: selection,
      });
    } catch (err) {
      if (err && err.__ccError === true) {
        return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
      }
      throw err;
    }
  }

  // 敏感导出：二次确认（confirm:true，FR-EXP-003）
  if (includePii && body.confirm !== true) {
    return jsonError(e, 400, 'confirm_required', '敏感导出需要二次确认（confirm:true）');
  }

  // --- 范围服务端校验（FR-EXP-004）：忽略客户端越权参数，机构范围由身份推导 ---
  const type = scope.type;
  const dateRange = scope.date_range || {};
  // from/to 仅接受纯日期（YYYY-MM-DD），非法格式 400；to 的当日结束边界在校验通过后拼接
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (dateRange.from && (typeof dateRange.from !== 'string' || !DATE_RE.test(dateRange.from))) {
    return jsonError(e, 400, 'validation_failed', 'scope.date_range.from 须为 YYYY-MM-DD 格式');
  }
  if (dateRange.to && (typeof dateRange.to !== 'string' || !DATE_RE.test(dateRange.to))) {
    return jsonError(e, 400, 'validation_failed', 'scope.date_range.to 须为 YYYY-MM-DD 格式');
  }
  let orgConstraint = null; // null = 全平台
  if (role === 'admin') {
    orgConstraint = auth.get('organization_id');
    if (type !== 'organization' && type !== 'activity') {
      return jsonError(e, 403, 'scope_forbidden', '机构管理员仅可导出本机构全部或指定单活动');
    }
  } else {
    if (['platform', 'organization', 'activity'].indexOf(type) < 0) {
      return jsonError(e, 400, 'validation_failed', 'scope.type 必须为 platform / organization / activity');
    }
    if (type === 'organization') {
      if (!scope.organization_id) {
        return jsonError(e, 400, 'validation_failed', '机构范围导出须指定 scope.organization_id');
      }
      try {
        $app.findRecordById('organizations', scope.organization_id);
      } catch (_) {
        return jsonError(e, 400, 'validation_failed', 'scope.organization_id 无效');
      }
      orgConstraint = scope.organization_id;
    }
  }

  let activities;
  if (type === 'activity') {
    if (!scope.activity_id) {
      return jsonError(e, 400, 'validation_failed', '单活动导出须指定 scope.activity_id');
    }
    let activity;
    try {
      activity = $app.findRecordById('activities', scope.activity_id);
    } catch (_) {
      return jsonError(e, 404, 'not_found', '活动不存在');
    }
    if (orgConstraint && activity.get('organization_id') !== orgConstraint) {
      return jsonError(e, 403, 'scope_forbidden', '无权导出其他机构的活动');
    }
    activities = [activity];
  } else if (orgConstraint) {
    activities = queryAll('activities', 'organization_id = {:o}', { o: orgConstraint }, 'created');
  } else {
    activities = queryAll('activities', '', {}, 'created');
  }
  // 时间范围筛选（重叠口径：活动 [start_time, end_time] 与 [from, to] 有交集即计入，
  // 与看板 metrics 口径一致，FR-DASH-002）
  if (dateRange.from) {
    activities = activities.filter((a) => (iso(a.get('end_time')) || iso(a.get('start_time'))) >= dateRange.from);
  }
  if (dateRange.to) {
    activities = activities.filter((a) => iso(a.get('start_time')) <= dateRange.to + 'T23:59:59.999Z');
  }

  // 敏感导出开关：机构管理员须本机构开启 allow_sensitive_export（FR-ORG-005、AC-17）
  if (includePii && role === 'admin') {
    const org = $app.findRecordById('organizations', auth.get('organization_id'));
    if (!org.get('allow_sensitive_export')) {
      return jsonError(e, 403, 'sensitive_export_disabled', '本机构未开启敏感导出开关');
    }
  }

  const organizationIds = [];
  activities.forEach((a) => {
    const o = a.get('organization_id');
    if (organizationIds.indexOf(o) < 0) organizationIds.push(o);
  });
  const scopeJson = {
    type,
    activity_id: type === 'activity' ? scope.activity_id : null,
    organization_id: orgConstraint,
    date_range: dateRange.from || dateRange.to ? { from: dateRange.from || null, to: dateRange.to || null } : null,
  };
  const orgIdForJob = type === 'platform' ? null : orgConstraint;

  // --- 组装全部 CSV ---
  const activityIds = activities.map((a) => a.id);

  // v1→v2 归一化存储（api-design §6.3）：scope_json 写 StoredExportSelectionV2
  // （source_schema_version=1），include_pii 由服务端判敏派生，不信任客户端布尔值；
  // 旧敏感导出含 participants.csv username（账号层敏感列），include_pii=true 恒记该原因
  const legacySelection = exportV2NormalizeLegacy(scopeJson, includePii, organizationIds, activityIds);
  const legacyAnalysis = exportV2AnalyzeSelection(legacySelection, organizationIds, activityIds);
  if (includePii) legacyAnalysis.reasons.push({ source: 'account_column', code: 'username' });
  const derivedPii = legacyAnalysis.reasons.length > 0;
  const storedSelection = Object.assign({}, legacySelection, { source_schema_version: 1 });
  const orgMap = {};
  organizationIds.forEach((oid) => {
    orgMap[oid] = $app.findRecordById('organizations', oid);
  });

  let registrations = [];
  let checkins = [];
  let surveys = [];
  if (activityIds.length > 0) {
    const f = inFilter('activity_id', activityIds);
    registrations = queryAll('registrations', f.filter, f.params, 'created');
    checkins = queryAll('checkins', f.filter, f.params, 'created');
    surveys = queryAll('activity_surveys', f.filter, f.params, 'created');
  }

  // 报名字段定义与问卷题目（敏感标记链路，FR-EXP-002）
  const fieldDefMap = {};
  queryAll('registration_field_defs', '', {}, 'created').forEach((d) => {
    fieldDefMap[d.id] = d;
  });
  const questionMap = {};
  const questionsBySurvey = {};
  if (surveys.length > 0) {
    const f = inFilter('activity_survey_id', surveys.map((s) => s.id));
    queryAll('survey_questions', f.filter, f.params, 'order_index').forEach((q) => {
      questionMap[q.get('activity_survey_id') + ':' + q.get('question_code')] = q;
      (questionsBySurvey[q.get('activity_survey_id')] = questionsBySurvey[q.get('activity_survey_id')] || []).push(q);
    });
  }

  // 答卷口径：排除作废（voided），与常规统计一致（database-design §5.2.16）
  let submissions = [];
  if (surveys.length > 0) {
    const f = inFilter('activity_survey_id', surveys.map((s) => s.id));
    submissions = queryAll('submissions', `(${f.filter}) && status != 'voided'`, f.params, 'created');
  }

  const files = [];

  // organizations.csv：管理员导出时仅本机构；超管可全平台（PRD §10.1）
  files.push({
    name: 'organizations.csv',
    text: buildCsv(
      ['organization_id', 'name', 'status', 'require_activity_approval', 'allow_sensitive_export', 'created'],
      Object.keys(orgMap).map((oid) => {
        const o = orgMap[oid];
        return [o.id, o.get('name'), o.get('status'), o.get('require_activity_approval'), o.get('allow_sensitive_export'), iso(o.get('created'))];
      }),
    ),
  });

  // activities.csv：无直接个人信息；group_tag 为预留列（可为空）
  files.push({
    name: 'activities.csv',
    text: buildCsv(
      ['activity_id', 'organization_id', 'activity_code', 'title', 'description', 'location', 'start_time', 'end_time', 'status', 'capacity_total', 'capacity_speaker', 'capacity_listener', 'registration_open', 'registration_start_at', 'registration_end_at', 'group_tag', 'created'],
      activities.map((a) => [
        a.id, a.get('organization_id'), a.get('activity_code'), a.get('title'), a.get('description'),
        a.get('location'), iso(a.get('start_time')), iso(a.get('end_time')), a.get('status'),
        a.get('capacity_total'), a.get('capacity_speaker'), a.get('capacity_listener'),
        a.get('registration_open'), iso(a.get('registration_start_at')), iso(a.get('registration_end_at')),
        a.get('group_tag'), iso(a.get('created')),
      ]),
    ),
  });

  // participants.csv：普通导出不含用户名；敏感导出可包含（PRD §10.1）
  const participantIds = [];
  registrations.forEach((r) => {
    const p = r.get('participant_id');
    if (participantIds.indexOf(p) < 0) participantIds.push(p);
  });
  const participantRows = [];
  participantIds.forEach((pid) => {
    try {
      const p = $app.findRecordById('participant_accounts', pid);
      const row = [p.id, p.get('status'), iso(p.get('created'))];
      if (includePii) row.push(p.get('username'));
      participantRows.push(row);
    } catch (_) {
      /* 账号异常缺失时跳过 */
    }
  });
  files.push({
    name: 'participants.csv',
    text: buildCsv(
      includePii ? ['participant_id', 'status', 'created', 'username'] : ['participant_id', 'status', 'created'],
      participantRows,
    ),
  });

  // registrations.csv：报名、角色、审核状态；participant_id 关联，无直接身份信息
  files.push({
    name: 'registrations.csv',
    text: buildCsv(
      ['registration_id', 'activity_id', 'participant_id', 'activity_role', 'status', 'submitted_at', 'status_reason', 'created'],
      registrations.map((r) => [
        r.id, r.get('activity_id'), r.get('participant_id'), r.get('activity_role'), r.get('status'),
        iso(r.get('submitted_at')), r.get('status_reason'), iso(r.get('created')),
      ]),
    ),
  });

  // registration_answers.csv：普通导出按字段 is_sensitive 标记排除（FR-EXP-002）
  let regAnswers = [];
  if (registrations.length > 0) {
    const f = inFilter('registration_id', registrations.map((r) => r.id));
    regAnswers = queryAll('registration_answers', f.filter, f.params, 'created');
  }
  const regAnswerRows = [];
  regAnswers.forEach((a) => {
    const def = fieldDefMap[a.get('field_def_id')];
    if (!def) return;
    if (!includePii && def.get('is_sensitive')) return; // 普通导出按标记排除
    regAnswerRows.push([
      a.get('registration_id'), def.get('field_code'), decodeJson(a.get('value_json')),
      def.get('source_type'), includePii ? String(!!def.get('is_sensitive')) : 'no',
    ]);
  });
  files.push({
    name: 'registration_answers.csv',
    text: buildCsv(['registration_id', 'field_code', 'value', 'source_type', 'is_sensitive'], regAnswerRows),
  });

  // checkins.csv：签到状态、时间、来源；participant_id 关联
  files.push({
    name: 'checkins.csv',
    text: buildCsv(
      ['checkin_id', 'activity_id', 'participant_id', 'registration_id', 'source', 'status', 'checked_in_at', 'operator_id', 'reason', 'revoked_at'],
      checkins.map((c) => [
        c.id, c.get('activity_id'), c.get('participant_id'), c.get('registration_id'), c.get('source'),
        c.get('status'), iso(c.get('checked_in_at')), c.get('operator_id'), c.get('reason'), iso(c.get('revoked_at')),
      ]),
    ),
  });

  // survey_templates.csv：范围内问卷引用的模板及版本元数据（无个人信息）
  const versionIds = [];
  surveys.forEach((s) => {
    const v = s.get('template_version_id');
    if (versionIds.indexOf(v) < 0) versionIds.push(v);
  });
  const tplRows = [];
  versionIds.forEach((vid) => {
    try {
      const v = $app.findRecordById('survey_template_versions', vid);
      const tpl = $app.findRecordById('survey_templates', v.get('template_id'));
      tplRows.push([tpl.get('template_code'), tpl.get('name'), v.get('version'), vid, iso(v.get('published_at'))]);
    } catch (_) {
      /* 模板缺失时跳过 */
    }
  });
  files.push({
    name: 'survey_templates.csv',
    text: buildCsv(['template_code', 'template_name', 'version', 'template_version_id', 'published_at'], tplRows),
  });

  // surveys.csv：活动问卷、角色、开放状态（无个人信息）
  files.push({
    name: 'surveys.csv',
    text: buildCsv(
      ['activity_survey_id', 'activity_id', 'survey_code', 'title', 'role_scope', 'status', 'opened_at', 'ended_at', 'template_version_id', 'created'],
      surveys.map((s) => [
        s.id, s.get('activity_id'), s.get('survey_code'), s.get('title'), s.get('role_scope'),
        s.get('status'), iso(s.get('opened_at')), iso(s.get('ended_at')), s.get('template_version_id'), iso(s.get('created')),
      ]),
    ),
  });

  // submissions.csv：提交状态与时间；排除作废（口径见上）
  files.push({
    name: 'submissions.csv',
    text: buildCsv(
      ['submission_id', 'activity_survey_id', 'participant_id', 'registration_id', 'status', 'submitted_at', 'created'],
      submissions.map((s) => [
        s.id, s.get('activity_survey_id'), s.get('participant_id'), s.get('registration_id'),
        s.get('status'), iso(s.get('submitted_at')), iso(s.get('created')),
      ]),
    ),
  });

  // answers.csv：question_code 与答案；普通导出按题目 is_sensitive 标记过滤（FR-EXP-002）
  const answerRows = [];
  if (submissions.length > 0) {
    const f = inFilter('submission_id', submissions.map((s) => s.id));
    const subSurveyMap = {};
    submissions.forEach((s) => {
      subSurveyMap[s.id] = s.get('activity_survey_id');
    });
    queryAll('answers', f.filter, f.params, 'created').forEach((a) => {
      const q = questionMap[subSurveyMap[a.get('submission_id')] + ':' + a.get('question_code')];
      const sensitive = q ? !!q.get('is_sensitive') : false;
      if (!includePii && sensitive) return; // 普通导出按标记排除
      answerRows.push([a.get('submission_id'), a.get('question_code'), decodeJson(a.get('value_json')), includePii ? String(sensitive) : 'no']);
    });
  }
  files.push({
    name: 'answers.csv',
    text: buildCsv(['submission_id', 'question_code', 'value', 'is_sensitive'], answerRows),
  });

  // custom_fields.csv：自定义报名字段 + 自定义问卷题目定义（含敏感标记，PRD §2.3/§10.1）
  const surveyActivityCache = {};
  const customRows = [];
  Object.keys(fieldDefMap).forEach((id) => {
    const d = fieldDefMap[id];
    if (d.get('source_type') !== 'custom') return;
    if (organizationIds.indexOf(d.get('organization_id')) < 0) return;
    customRows.push(['registration_field', d.get('field_code'), d.get('label'), d.get('field_type'), String(!!d.get('is_sensitive')), d.get('organization_id'), '', '']);
  });
  Object.keys(questionsBySurvey).forEach((sid) => {
    questionsBySurvey[sid].forEach((q) => {
      if (q.get('source_type') !== 'custom') return;
      if (!(sid in surveyActivityCache)) {
        try {
          surveyActivityCache[sid] = $app.findRecordById('activity_surveys', sid).get('activity_id');
        } catch (_) {
          surveyActivityCache[sid] = '';
        }
      }
      customRows.push(['survey_question', q.get('question_code'), q.get('title'), q.get('question_type'), String(!!q.get('is_sensitive')), '', sid, surveyActivityCache[sid]]);
    });
  });
  files.push({
    name: 'custom_fields.csv',
    text: buildCsv(
      ['kind', 'code', 'label', 'field_type', 'is_sensitive', 'organization_id', 'activity_survey_id', 'activity_id'],
      customRows,
    ),
  });

  // data_dictionary.csv：字段说明、枚举、版本与敏感标记（AC-16；下游可复现过滤口径）
  const dictStatic = {
    'organizations.csv': {
      organization_id: '机构 ID', name: '机构名称', status: '机构状态（active=启用, disabled=停用）',
      require_activity_approval: '活动发布是否需平台审核', allow_sensitive_export: '是否允许机构管理员敏感导出',
      created: '创建时间（ISO 8601 UTC）',
    },
    'activities.csv': {
      activity_id: '活动 ID', organization_id: '所属机构 ID', activity_code: '活动可读稳定代码',
      title: '活动标题', description: '活动描述', location: '地点',
      start_time: '开始时间（ISO 8601 UTC）', end_time: '结束时间（ISO 8601 UTC）',
      status: '活动状态（draft/pending_review/rejected/published/closed/taken_down/archived）',
      capacity_total: '总名额', capacity_speaker: '倾诉者名额', capacity_listener: '聆听者名额',
      registration_open: '报名手动开关', registration_start_at: '报名开始时间', registration_end_at: '报名结束时间',
      group_tag: '预留分组字段（V1 不使用，可为空）', created: '创建时间（ISO 8601 UTC）',
    },
    'participants.csv': {
      participant_id: '参与者 ID（全平台稳定，跨表关联键）', status: '账号状态（active/disabled）',
      created: '注册时间（ISO 8601 UTC）', username: '用户名（仅敏感导出包含）',
    },
    'registrations.csv': {
      registration_id: '报名 ID（参与者×活动唯一）', activity_id: '活动 ID', participant_id: '参与者 ID',
      activity_role: '活动内角色（speaker=倾诉者, listener=聆听者）',
      status: '报名状态（pending=待审核, approved=已通过, rejected=已拒绝, cancelled=已取消）',
      submitted_at: '报名提交时间（ISO 8601 UTC）', status_reason: '最近一次状态变更原因', created: '创建时间',
    },
    'registration_answers.csv': {
      registration_id: '报名 ID', field_code: '报名字段稳定代码',
      value: '答案值（多选为标准 JSON 数组；普通导出按字段 is_sensitive 排除敏感字段）',
      source_type: '字段来源（standard/custom）', is_sensitive: '该字段敏感标记（普通导出恒为 no）',
    },
    'checkins.csv': {
      checkin_id: '签到记录 ID', activity_id: '活动 ID', participant_id: '参与者 ID', registration_id: '报名 ID',
      source: '签到来源（self_scan=自助扫码, manual=管理员补签）', status: '签到状态（valid=有效, revoked=已撤销）',
      checked_in_at: '签到时间（ISO 8601 UTC）', operator_id: '补签/撤销操作管理员 ID',
      reason: '补签/撤销原因', revoked_at: '撤销时间',
    },
    'survey_templates.csv': {
      template_code: '模板代码', template_name: '模板名称', version: '模板版本号',
      template_version_id: '模板版本 ID', published_at: '版本发布时间（ISO 8601 UTC）',
    },
    'surveys.csv': {
      activity_survey_id: '活动问卷 ID', activity_id: '活动 ID', survey_code: '问卷稳定代码',
      title: '问卷标题', role_scope: '适用角色（speaker/listener/both）',
      status: '问卷状态（draft/not_open/open/ended/archived）',
      opened_at: '开放时间', ended_at: '结束时间', template_version_id: '来源模板版本 ID', created: '创建时间',
    },
    'submissions.csv': {
      submission_id: '答卷 ID', activity_survey_id: '活动问卷 ID', participant_id: '参与者 ID',
      registration_id: '报名 ID', status: '答卷状态（draft=草稿, submitted=已提交；作废已排除）',
      submitted_at: '正式提交时间（ISO 8601 UTC）', created: '创建时间',
    },
    'answers.csv': {
      submission_id: '答卷 ID', question_code: '题目稳定代码（标准题跨模板一致，自定义题活动内唯一）',
      value: '答案值（多选为标准 JSON 数组；普通导出按题目 is_sensitive 排除敏感题）',
      is_sensitive: '该题敏感标记（普通导出恒为 no）',
    },
    'custom_fields.csv': {
      kind: '定义类型（registration_field=报名字段, survey_question=问卷题目）',
      code: '字段/题目代码', label: '展示文案', field_type: '题型', is_sensitive: '敏感标记',
      organization_id: '归属机构（报名字段）', activity_survey_id: '归属问卷（题目）', activity_id: '归属活动（题目）',
    },
    'manifest.csv': { key: '清单项', value: '清单值' },
  };
  const dictRows = [];
  Object.keys(dictStatic).forEach((file) => {
    Object.keys(dictStatic[file]).forEach((col) => {
      const sensitive =
        (file === 'participants.csv' && col === 'username') ||
        ((file === 'registration_answers.csv' || file === 'answers.csv') && col === 'value');
      dictRows.push([file, col, dictStatic[file][col], sensitive ? 'conditional' : 'no']);
    });
  });
  // 动态行：范围内字段与题目的敏感标记
  Object.keys(fieldDefMap).forEach((id) => {
    const d = fieldDefMap[id];
    if (d.get('organization_id') && organizationIds.indexOf(d.get('organization_id')) < 0) return;
    dictRows.push([
      'registration_answers.csv', 'field:' + d.get('field_code'),
      '报名字段「' + d.get('label') + '」（' + d.get('source_type') + '）',
      d.get('is_sensitive') ? 'yes' : 'no',
    ]);
  });
  Object.keys(questionsBySurvey).forEach((sid) => {
    questionsBySurvey[sid].forEach((q) => {
      dictRows.push([
        'answers.csv', 'question:' + q.get('question_code'),
        '问卷题目「' + q.get('title') + '」（' + q.get('source_type') + '，问卷 ' + sid + '）',
        q.get('is_sensitive') ? 'yes' : 'no',
      ]);
    });
  });
  files.push({
    name: 'data_dictionary.csv',
    text: buildCsv(['file', 'column', 'description', 'is_sensitive'], dictRows),
  });

  // manifest.csv：导出范围、时间、版本、文件行数、是否含个人信息（PRD §10.1）
  const manifestRows = [
    ['export_format_version', EXPORT_FORMAT_VERSION],
    ['generated_at', new Date().toISOString()],
    ['timezone', 'UTC'],
    ['scope_type', scopeJson.type],
    ['scope_activity_id', scopeJson.activity_id || ''],
    ['scope_organization_id', scopeJson.organization_id || ''],
    ['scope_date_from', (scopeJson.date_range && scopeJson.date_range.from) || ''],
    ['scope_date_to', (scopeJson.date_range && scopeJson.date_range.to) || ''],
    ['include_pii', String(includePii)],
    ['created_by', auth.id],
    ['voided_submissions_excluded', 'yes'],
    ['sensitive_filter', includePii ? 'disabled (sensitive export)' : 'is_sensitive excluded'],
  ];
  files.forEach((f) => {
    // 数据行数 = 总行数 - 表头 - 结尾空行
    manifestRows.push(['file_rows.' + f.name, String(Math.max(f.text.split('\r\n').length - 2, 0))]);
  });
  files.push({ name: 'manifest.csv', text: buildCsv(['key', 'value'], manifestRows) });

  // --- 生成 ZIP 并写入受保护目录；文件名随机不可猜（FR-EXP-005）---
  let zipBytes;
  let fileName;
  let checksum;
  let genError = null;
  try {
    zipBytes = buildZip(files);
    fileName = 'cc_export_' + $security.randomString(24) + '.zip';
    checksum = $security.sha256(zipBytes);
    $os.mkdirAll(EXPORT_DIR, 0o700);
    $os.writeFile(EXPORT_DIR + '/' + fileName, zipBytes, 0o600);
  } catch (err) {
    genError = err;
  }

  // export_jobs 留痕（导出人/范围/时间/是否含个人信息/文件校验信息，PRD §10.3）；
  // job + 审计同事务提交（留痕与审计不可分）
  let job = null;
  $app.runInTransaction((txApp) => {
    const jobsCol = txApp.findCollectionByNameOrId('export_jobs');
    job = new Record(jobsCol);
    if (orgIdForJob) job.set('organization_id', orgIdForJob);
    job.set('scope_json', storedSelection);
    job.set('include_pii', derivedPii);
    job.set('file_path', genError ? '-' : EXPORT_DIR + '/' + fileName);
    job.set('file_checksum', genError ? '' : checksum);
    job.set('status', genError ? 'failed' : 'done');
    job.set('created_by', auth.id);
    txApp.save(job);

    // 审计：普通导出 / 敏感导出（security-privacy §8.1 数据类）；
    // metadata 只记范围/筛选/机器码/格式，不记完整手机号、姓名或答案值（api-design §6.2）
    writeAudit(txApp, {
      actorId: auth.id,
      actorRole: role === 'admin' ? 'admin' : 'super_admin',
      organizationId: orgIdForJob || undefined,
      action: derivedPii ? 'export.sensitive' : 'export.normal',
      targetType: 'export_job',
      targetId: job.id,
      result: genError ? 'failure' : 'success',
      metadata: {
        schema_version: 2,
        source_schema_version: 1,
        scope: storedSelection.scope,
        datasets: storedSelection.datasets,
        format: storedSelection.format,
        timezone: storedSelection.timezone,
        filters: storedSelection.filters,
        system_columns: storedSelection.columns.system,
        field_codes: storedSelection.columns.registration_field_codes,
        survey_questions: storedSelection.columns.survey_questions,
        requires_sensitive_export: derivedPii,
        sensitive_reasons: legacyAnalysis.reasons,
        confirm: body.confirm === true,
        activity_count: activities.length,
        error: genError ? String(genError) : undefined,
      },
    });
  });

  if (genError) {
    return jsonError(e, 500, 'internal_error', '导出文件生成失败，请稍后重试');
  }
  return e.json(200, {
    export_job: {
      id: job.id,
      status: job.get('status'),
      scope: scopeJson,
      include_pii: derivedPii,
      file_checksum: checksum,
      created: iso(job.get('created')),
    },
  });
});

// ---------------------------------------------------------------------------
// 端点 2：GET /api/cc/exports/{id}/download — 鉴权下载（不可猜路径 + 机构校验）
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/cc/exports/{id}/download', (e) => {
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
  // 写一条审计日志（与 lib/audit.pb.js 同源）
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
  // JSON 字段读出为原始字节，须 String 化后 JSON.parse（0.28.4 实测）
  const decodeJson = (val, fallback) => {
    try { const v = JSON.parse(String(val == null ? '' : val)); return v == null ? fallback : v; } catch (err) { return fallback; }
  };
  const EXPORT_DIR = $app.dataDir() + '/exports'; // 与生成端一致

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

  let job;
  try {
    job = $app.findRecordById('export_jobs', e.request.pathValue('id'));
  } catch (_) {
    return jsonError(e, 404, 'not_found', '导出任务不存在');
  }
  // 机构管理员仅可下载本机构导出任务（FR-EXP-004/005、FR-ORG-006）
  if (role === 'admin' && job.get('organization_id') !== auth.get('organization_id')) {
    return jsonError(e, 403, 'forbidden', '无权下载其他机构的导出文件');
  }
  if (job.get('status') !== 'done') {
    return jsonError(e, 400, 'export_not_ready', '导出任务未完成，无法下载');
  }

  const filePath = job.get('file_path');
  // 路径防护：只允许读取受保护导出目录内的文件
  if (!filePath || filePath.indexOf(EXPORT_DIR + '/') !== 0 || filePath.indexOf('..') >= 0) {
    return jsonError(e, 500, 'internal_error', '导出文件路径异常');
  }
  let bytes;
  try {
    bytes = $os.readFile(filePath);
  } catch (_) {
    return jsonError(e, 404, 'file_missing', '导出文件不存在或已被移除');
  }

  // v2 任务的格式从存储的 scope_json 派生（xlsx 或 zip；v1 任务恒为 zip）
  const storedScope = decodeJson(job.get('scope_json'), null);
  const isXlsx = storedScope && storedScope.schema_version === 2 && storedScope.format === 'xlsx';

  // 审计：导出文件下载成功（security-privacy §8.1 数据类，留痕下载动作）
  writeAudit($app, {
    actorId: auth.id,
    actorRole: role === 'admin' ? 'admin' : 'super_admin',
    organizationId: job.get('organization_id') || undefined,
    action: 'export.download',
    targetType: 'export_job',
    targetId: job.id,
    result: 'success',
    metadata: { export_job_id: job.id, scope: storedScope },
  });

  e.response.header().set(
    'Content-Disposition',
    'attachment; filename="chatcircles_export_' + job.id + (isXlsx ? '.xlsx' : '.zip') + '"',
  );
  return e.blob(
    200,
    isXlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/zip',
    bytes,
  );
});
