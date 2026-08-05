// Chat Circles — exports.pb.js：导出域 hooks（后端 B）
// 职责（technical-design §5.5、PRD §10、FR-EXP-001~006、AC-16/17、security-privacy §4/§10）：
// - POST /api/cc/exports：范围服务端校验（管理员=本机构全部或指定单活动；超管=全平台/机构/单活动，
//   忽略客户端越权参数，FR-EXP-004）+ 敏感导出开关（机构 allow_sensitive_export，FR-ORG-005）+
//   二次确认（confirm:true，FR-EXP-003）+ 审计（普通 export.normal / 敏感 export.sensitive，
//   security-privacy §8.1 数据类）；同步生成 ZIP 并留痕 export_jobs（导出人/范围/时间/
//   是否含个人信息/文件校验信息，PRD §10.3）。
// - ZIP 内容（PRD §10.1 全部 CSV 清单）：organizations / activities / participants /
//   registrations / registration_answers / checkins / survey_templates / surveys / submissions /
//   answers / custom_fields / data_dictionary / manifest，共 13 个 CSV。
//   格式规则（PRD §10.3）：UTF-8 BOM、稳定英文列名、ISO 8601 时间（UTC，显式时区）、
//   缺失值用空值、多选答案用标准 JSON 数组。
// - 敏感过滤（FR-EXP-002、AC-16）：普通导出按 is_sensitive 标记排除（registration_field_defs
//   与 survey_questions 两个标记位，禁止按字段名启发式判断）；主体关联用 participant_id，
//   普通导出不导出用户名；作废答卷（status=voided）不计入导出口径（database-design §5.2.16）。
// - GET /api/cc/exports/{id}/download：鉴权下载（管理员仅本机构任务、超管全部），
//   文件存受保护目录（pb_data/exports，非公开静态路径），文件名随机不可猜（FR-EXP-005）。
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
  const ccError = (status, code, message) => {
    throw new ApiError(status, message, { code });
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

  // CSV 单元格转义；缺失值输出空值（不以 0/-1/"无" 代替，PRD §10.3）
  const csvCell = (v) => {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'object') v = JSON.stringify(v); // 多选答案用标准 JSON 数组（PRD §10.3）
    v = String(v);
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

  const body = e.requestInfo().body || {};
  const scope = body.scope || {};
  const includePii = body.include_pii === true;

  // 敏感导出：二次确认（confirm:true，FR-EXP-003）
  if (includePii && body.confirm !== true) {
    return jsonError(e, 400, 'confirm_required', '敏感导出需要二次确认（confirm:true）');
  }

  // --- 范围服务端校验（FR-EXP-004）：忽略客户端越权参数，机构范围由身份推导 ---
  const type = scope.type;
  const dateRange = scope.date_range || {};
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
  // 时间范围筛选（作用于活动开始时间）
  if (dateRange.from) {
    activities = activities.filter((a) => iso(a.get('start_time')) >= dateRange.from);
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

  // export_jobs 留痕（导出人/范围/时间/是否含个人信息/文件校验信息，PRD §10.3）
  const jobsCol = $app.findCollectionByNameOrId('export_jobs');
  const job = new Record(jobsCol);
  if (orgIdForJob) job.set('organization_id', orgIdForJob);
  job.set('scope_json', scopeJson);
  job.set('include_pii', includePii);
  job.set('file_path', genError ? '-' : EXPORT_DIR + '/' + fileName);
  job.set('file_checksum', genError ? '' : checksum);
  job.set('status', genError ? 'failed' : 'done');
  job.set('created_by', auth.id);
  $app.save(job);

  // 审计：普通导出 / 敏感导出（security-privacy §8.1 数据类）
  writeAudit($app, {
    actorId: auth.id,
    actorRole: role === 'admin' ? 'admin' : 'super_admin',
    organizationId: orgIdForJob || undefined,
    action: includePii ? 'export.sensitive' : 'export.normal',
    targetType: 'export_job',
    targetId: job.id,
    result: genError ? 'failure' : 'success',
    metadata: {
      scope: scopeJson,
      include_pii: includePii,
      confirm: body.confirm === true,
      activity_count: activities.length,
      error: genError ? String(genError) : undefined,
    },
  });

  if (genError) {
    return jsonError(e, 500, 'internal_error', '导出文件生成失败：' + genError);
  }
  return e.json(200, {
    export_job: {
      id: job.id,
      status: job.get('status'),
      scope: scopeJson,
      include_pii: includePii,
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
  const ccError = (status, code, message) => {
    throw new ApiError(status, message, { code });
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

  e.response.header().set('Content-Disposition', 'attachment; filename="chatcircles_export_' + job.id + '.zip"');
  return e.blob(200, 'application/zip', bytes);
});
