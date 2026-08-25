// Chat Circles — super.pb.js：超级管理员域 hooks（后端 B）
// 职责（technical-design §5.4/§5.8、PRD §4.2/§12.3、FR-ORG-002/003、AC-23、security-privacy §8/§11）：
// - POST /api/cc/super/invites：生成一次性管理员邀请码。只存 token_hash（sha256），
//   明文仅在本次响应返回一次、不落库（database-design §5.2.2）；默认 7 天有效期
//   （expires_in_days 可调）；写审计 invite.generate（security-privacy §8.1 账号类）。
// - POST /api/cc/super/invites/{id}/revoke：撤销未使用邀请码（4 态机 unused → revoked），
//   写审计 invite.revoke。
// - GET /api/cc/super/backup-status：读取最近一次备份审计（action=backup.*），
//   失败时 alert=true，供超级管理端显著告警（PRD §12.3、AC-23）。
// - POST /api/cc/super/backup/run：已下线（410 Gone，假备份治理：JSVM 库文件复制非一致性
//   快照）；每日一致性快照由 deploy/backup.sh 负责（technical-design §5.8）。
// - POST /api/cc/super/templates：新建问卷模板 + 首个版本（事务：建模板 → 建首版 →
//   回补 current_version_id 循环引用，FR-SUR-001），写审计 template.create（PRD §11.3）。
// - POST /api/cc/super/templates/{id}/publish：发布模板新版本（事务：校验并规范化
//   schema_json → 建版本（version=max+1）→ 移动 current_version_id；已发布版本不可变、
//   只影响之后新建问卷，FR-SUR-011），写审计 template.publish（PRD §11.3）。
//   schema_json 题目契约与 surveys.pb.js 物化层一致（兼容 options/options_json 双命名），
//   本端点统一规范化为 options_json/order_index/validation_json 命名后落库。
// 鉴权：全部端点仅 PocketBase _superusers 会话可用，不复用机构管理员规则（PRD §12.2）。
//
// 实现注意（PocketBase 0.28 JSVM 实测）：handler 在请求期以全新作用域执行，文件级函数/常量
// 对 handler 不可见，故每个 handler 自包含、共享 lib 在 handler 内 require。

// ---------------------------------------------------------------------------
// POST /api/cc/super/invites — 生成一次性邀请码
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/super/invites', (e) => {
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
    auth = requireAuth(e, 'super');
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }

  const body = e.requestInfo().body || {};
  if (!body.organization_id) {
    return jsonError(e, 400, 'validation_failed', 'organization_id 必填');
  }
  let org;
  try {
    org = $app.findRecordById('organizations', body.organization_id);
  } catch (_) {
    return jsonError(e, 400, 'validation_failed', 'organization_id 无效');
  }
  let days = 7; // 默认生成后 7 天（PRD §4.2）
  if (body.expires_in_days !== undefined && body.expires_in_days !== null) {
    days = Number(body.expires_in_days);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      return jsonError(e, 400, 'validation_failed', 'expires_in_days 须为 1~90 的整数');
    }
  }

  // 明文仅本次响应返回一次；库中只存 sha256 哈希（database-design §5.2.2、security-privacy §7）
  const token = 'cc_inv_' + $security.randomString(24);
  const tokenHash = $security.sha256(token);
  const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);

  const col = $app.findCollectionByNameOrId('admin_invites');
  const invite = new Record(col);
  invite.set('organization_id', org.id);
  invite.set('token_hash', tokenHash);
  invite.set('status', 'unused');
  invite.set('expires_at', expiresAt.toISOString());
  invite.set('created_by', auth.id);
  $app.save(invite);

  writeAudit($app, {
    actorId: auth.id,
    actorRole: 'super_admin',
    organizationId: org.id,
    action: 'invite.generate',
    targetType: 'admin_invite',
    targetId: invite.id,
    result: 'success',
    metadata: { expires_at: expiresAt.toISOString(), expires_in_days: days },
  });

  return e.json(200, {
    invite: {
      id: invite.id,
      organization_id: org.id,
      token, // 明文仅此一次
      status: 'unused',
      expires_at: expiresAt.toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/cc/super/invites/{id}/revoke — 撤销邀请码
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/super/invites/{id}/revoke', (e) => {
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
    auth = requireAuth(e, 'super');
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }

  let invite;
  try {
    invite = $app.findRecordById('admin_invites', e.request.pathValue('id'));
  } catch (_) {
    return jsonError(e, 404, 'not_found', '邀请码不存在');
  }
  if (invite.get('status') !== 'unused') {
    return jsonError(e, 400, 'invalid_transition', '仅未使用的邀请码可撤销，当前状态：' + invite.get('status'));
  }

  // 业务写 + 审计同事务提交（状态变更与留痕不可分）
  $app.runInTransaction((txApp) => {
    const from = invite.get('status');
    invite.set('status', 'revoked');
    txApp.save(invite);

    writeAudit(txApp, {
      actorId: auth.id,
      actorRole: 'super_admin',
      organizationId: invite.get('organization_id'),
      action: 'invite.revoke',
      targetType: 'admin_invite',
      targetId: invite.id,
      result: 'success',
      metadata: { from, to: 'revoked' },
    });
  });

  return e.json(200, { id: invite.id, status: 'revoked' });
});

// ---------------------------------------------------------------------------
// GET /api/cc/super/backup-status — 最近备份结果与失败告警标记
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/cc/super/backup-status', (e) => {
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

  try {
    requireAuth(e, 'super');
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }

  const recent = $app.findRecordsByFilter(
    'audit_logs',
    "action = 'backup.success' || action = 'backup.failed'",
    '-created',
    1,
    0,
    {},
  );
  // JSON 字段读出为原始字节，须 String 化后 JSON.parse 再下发（0.28.4 实测）
  const decodeJson = (val, fallback) => {
    try { const v = JSON.parse(String(val == null ? '' : val)); return v == null ? fallback : v; } catch (err) { return fallback; }
  };
  if (!recent || recent.length === 0) {
    return e.json(200, { last_backup: null, alert: true, message: '尚无备份记录' });
  }
  const last = recent[0];
  const failed = last.get('result') === 'failure' || last.get('action') === 'backup.failed';
  // 新鲜度检查（防陈旧成功掩盖中断）：备份为每日任务，最近一次成功超过
  // 24h+12h 宽限仍未刷新，说明 cron 未运行或持续失败于登录等前置阶段
  // （此类失败拿不到 token、写不了审计），须同样告警；created 解析失败按告警处理
  const STALE_MS = 36 * 3600 * 1000;
  const createdIso = String(last.get('created')).replace(' ', 'T');
  const createdMs = Date.parse(createdIso);
  const stale = !failed && (!(createdMs > 0) || Date.now() - createdMs > STALE_MS);
  const metadata = decodeJson(last.get('metadata'), null);
  return e.json(200, {
    last_backup: {
      action: last.get('action'),
      result: last.get('result'),
      created: createdIso,
      reason: last.get('reason'),
      file: metadata && metadata.file ? metadata.file : null,
      metadata: metadata,
    },
    alert: failed || stale,
    stale: stale,
    ...(stale
      ? { message: '最近一次成功备份已超过 36 小时，自动备份任务疑似中断（cron 未运行或失败于登录等前置阶段，此类失败无法写审计）' }
      : {}),
  });
});

// ---------------------------------------------------------------------------
// POST /api/cc/super/backup/run — 已下线（410 Gone）
// JSVM 无法调用 PocketBase 内部一致性备份（createBackup 需 Go context，hooks 内不可用），
// 原「库文件复制」并非一致性快照（假备份，可能截断写入中的页）；每日一致性快照由
// deploy/backup.sh（POST /api/backups，SQLite 在线备份）负责（technical-design §5.8）。
// 不再写 backup.success 审计，force_fail 故障注入参数一并移除。
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/super/backup/run', (e) => {
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

  try {
    requireAuth(e, 'super');
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }

  return jsonError(e, 410, 'backup_deprecated', '手动备份端点已下线：每日一致性快照备份由系统自动执行（deploy/backup.sh），如需恢复备份请联系运维');
});

// ---------------------------------------------------------------------------
// POST /api/cc/super/templates — 新建问卷模板 + 首个版本（事务）
// body: { template_code, name, description?, schema_json }
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/super/templates', (e) => {
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
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };

  // schema_json 校验 + 规范化（与 templates/{id}/publish 同实现；契约见 surveys.pb.js 头部，
  // 兼容 options/options_json、order/order_index、validation/validation_json 双命名，
  // 落库统一为 options_json/order_index/validation_json，order_index 按数组顺序 0 起始生成）
  const QUESTION_TYPES = ['info', 'single_choice', 'multi_choice', 'scale_1_5', 'scale_0_10', 'text_short', 'text_long'];
  const validateAndNormalizeSchema = (schema) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return { error: 'schema_json 必须为对象' };
    }
    const qs = schema.questions;
    if (!Array.isArray(qs) || qs.length === 0) {
      return { error: 'schema_json.questions 必须为非空数组' };
    }
    const seen = {};
    const normalized = [];
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i] || {};
      const at = '第 ' + (i + 1) + ' 题';
      const code = String(q.question_code == null ? '' : q.question_code).trim();
      if (!code) return { error: at + '：question_code 必填' };
      if (!/^[A-Za-z0-9_]{1,50}$/.test(code)) {
        return { error: at + '：question_code 仅允许字母/数字/下划线（≤50 字符）' };
      }
      if (seen[code]) return { error: at + '：question_code 重复（' + code + '）' };
      seen[code] = true;
      if (QUESTION_TYPES.indexOf(q.question_type) < 0) {
        return { error: at + '（' + code + '）：question_type 无效（' + q.question_type + '）' };
      }
      const title = String(q.title == null ? '' : q.title).trim();
      if (!title) return { error: at + '（' + code + '）：title 必填' };
      const nq = {
        question_code: code,
        question_type: q.question_type,
        title: title,
        required: !!q.required,
        locked: !!q.locked,
        is_sensitive: !!q.is_sensitive,
        order_index: i,
      };
      if (q.question_type === 'single_choice' || q.question_type === 'multi_choice') {
        const rawOpts = q.options_json && Array.isArray(q.options_json.options)
          ? q.options_json.options
          : (Array.isArray(q.options) ? q.options : null);
        if (!rawOpts || rawOpts.length === 0) {
          return { error: at + '（' + code + '）：选择题至少需 1 个选项' };
        }
        const seenVal = {};
        const nopts = [];
        for (let j = 0; j < rawOpts.length; j++) {
          const o = rawOpts[j] || {};
          const val = String(o.value == null ? '' : o.value).trim();
          const label = String(o.label == null ? '' : o.label).trim();
          if (!val || !label) return { error: at + '（' + code + '）选项 ' + (j + 1) + '：value 与 label 必填' };
          if (seenVal[val]) return { error: at + '（' + code + '）：选项 value 重复（' + val + '）' };
          seenVal[val] = true;
          nopts.push({ value: val, label: label });
        }
        nq.options_json = { options: nopts };
      }
      const validation = q.validation_json !== undefined ? q.validation_json : q.validation;
      if (validation && typeof validation === 'object' && !Array.isArray(validation)) {
        nq.validation_json = validation;
      }
      normalized.push(nq);
    }
    return { questions: normalized };
  };

  let auth;
  try {
    auth = requireAuth(e, 'super');
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }

  const body = e.requestInfo().body || {};
  const templateCode = String(body.template_code == null ? '' : body.template_code).trim();
  if (!/^[A-Z][A-Z0-9_]{1,49}$/.test(templateCode)) {
    return jsonError(e, 400, 'validation_failed', 'template_code 必填，须为大写字母开头的 2~50 位大写字母/数字/下划线（PRD 附录 B）');
  }
  const name = String(body.name == null ? '' : body.name).trim();
  if (!name) {
    return jsonError(e, 400, 'validation_failed', 'name 必填');
  }
  const description = String(body.description == null ? '' : body.description).trim();

  const check = validateAndNormalizeSchema(body.schema_json);
  if (check.error) {
    return jsonError(e, 400, 'validation_failed', check.error);
  }

  // template_code 唯一预检（唯一索引 idx_survey_templates_code 兜底）
  try {
    $app.findFirstRecordByFilter('survey_templates', 'template_code = {:c}', { c: templateCode });
    return jsonError(e, 400, 'validation_failed', 'template_code 已存在（' + templateCode + '）');
  } catch (_) {
    // 不存在，可创建
  }

  // 预生成首版 id：current_version_id ↔ template_id 循环引用，模板首存时版本尚未落库，
  // 故模板行用 saveNoValidate 首存（关系目标在同事务内随后创建），版本行走常规校验。
  const versionId = $security.randomStringWithAlphabet(15, 'abcdefghijklmnopqrstuvwxyz0123456789');
  const publishedAt = new Date().toISOString();
  let template;
  try {
    $app.runInTransaction((txApp) => {
      const templatesCol = txApp.findCollectionByNameOrId('survey_templates');
      const versionsCol = txApp.findCollectionByNameOrId('survey_template_versions');

      const tpl = new Record(templatesCol);
      tpl.set('template_code', templateCode);
      tpl.set('name', name);
      tpl.set('description', description);
      tpl.set('status', 'active');
      tpl.set('current_version_id', versionId);
      txApp.saveNoValidate(tpl);

      const ver = new Record(versionsCol);
      ver.set('id', versionId);
      ver.set('template_id', tpl.id);
      ver.set('version', 1);
      ver.set('schema_json', { questions: check.questions });
      ver.set('published_at', publishedAt);
      ver.set('published_by', auth.id);
      txApp.save(ver);

      writeAudit(txApp, {
        actorId: auth.id,
        actorRole: 'super_admin',
        action: 'template.create',
        targetType: 'survey_template',
        targetId: tpl.id,
        result: 'success',
        metadata: { template_code: templateCode, version: 1, question_count: check.questions.length },
      });

      template = tpl;
    });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    return jsonError(e, 500, 'internal_error', '新建模板失败，请稍后重试');
  }

  return e.json(200, {
    template: {
      id: template.id,
      template_code: templateCode,
      name: name,
      status: 'active',
      current_version_id: versionId,
    },
    version: { id: versionId, version: 1, question_count: check.questions.length },
  });
});

// ---------------------------------------------------------------------------
// POST /api/cc/super/templates/{id}/publish — 发布模板新版本（事务）
// body: { schema_json }；version = 当前最大版本 + 1，已发布版本不可变（FR-SUR-011）
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/super/templates/{id}/publish', (e) => {
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
    if (role === 'super') {
      if (collectionName !== '_superusers') ccError(403, 'FORBIDDEN', '无权限：需要超级管理员身份');
      return auth;
    }
    ccError(500, 'INVALID_ROLE', '内部错误：未知的身份角色要求');
  };

  // schema_json 校验 + 规范化（与 templates 新建端点同实现，契约与规范化约定见该处注释）
  const QUESTION_TYPES = ['info', 'single_choice', 'multi_choice', 'scale_1_5', 'scale_0_10', 'text_short', 'text_long'];
  const validateAndNormalizeSchema = (schema) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return { error: 'schema_json 必须为对象' };
    }
    const qs = schema.questions;
    if (!Array.isArray(qs) || qs.length === 0) {
      return { error: 'schema_json.questions 必须为非空数组' };
    }
    const seen = {};
    const normalized = [];
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i] || {};
      const at = '第 ' + (i + 1) + ' 题';
      const code = String(q.question_code == null ? '' : q.question_code).trim();
      if (!code) return { error: at + '：question_code 必填' };
      if (!/^[A-Za-z0-9_]{1,50}$/.test(code)) {
        return { error: at + '：question_code 仅允许字母/数字/下划线（≤50 字符）' };
      }
      if (seen[code]) return { error: at + '：question_code 重复（' + code + '）' };
      seen[code] = true;
      if (QUESTION_TYPES.indexOf(q.question_type) < 0) {
        return { error: at + '（' + code + '）：question_type 无效（' + q.question_type + '）' };
      }
      const title = String(q.title == null ? '' : q.title).trim();
      if (!title) return { error: at + '（' + code + '）：title 必填' };
      const nq = {
        question_code: code,
        question_type: q.question_type,
        title: title,
        required: !!q.required,
        locked: !!q.locked,
        is_sensitive: !!q.is_sensitive,
        order_index: i,
      };
      if (q.question_type === 'single_choice' || q.question_type === 'multi_choice') {
        const rawOpts = q.options_json && Array.isArray(q.options_json.options)
          ? q.options_json.options
          : (Array.isArray(q.options) ? q.options : null);
        if (!rawOpts || rawOpts.length === 0) {
          return { error: at + '（' + code + '）：选择题至少需 1 个选项' };
        }
        const seenVal = {};
        const nopts = [];
        for (let j = 0; j < rawOpts.length; j++) {
          const o = rawOpts[j] || {};
          const val = String(o.value == null ? '' : o.value).trim();
          const label = String(o.label == null ? '' : o.label).trim();
          if (!val || !label) return { error: at + '（' + code + '）选项 ' + (j + 1) + '：value 与 label 必填' };
          if (seenVal[val]) return { error: at + '（' + code + '）：选项 value 重复（' + val + '）' };
          seenVal[val] = true;
          nopts.push({ value: val, label: label });
        }
        nq.options_json = { options: nopts };
      }
      const validation = q.validation_json !== undefined ? q.validation_json : q.validation;
      if (validation && typeof validation === 'object' && !Array.isArray(validation)) {
        nq.validation_json = validation;
      }
      normalized.push(nq);
    }
    return { questions: normalized };
  };

  let auth;
  try {
    auth = requireAuth(e, 'super');
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }

  let template;
  try {
    template = $app.findRecordById('survey_templates', e.request.pathValue('id'));
  } catch (_) {
    return jsonError(e, 404, 'not_found', '模板不存在');
  }
  if (template.get('status') !== 'active') {
    return jsonError(e, 400, 'invalid_transition', '模板已停用，不能发布新版本');
  }

  const body = e.requestInfo().body || {};
  const check = validateAndNormalizeSchema(body.schema_json);
  if (check.error) {
    return jsonError(e, 400, 'validation_failed', check.error);
  }

  let published;
  try {
    $app.runInTransaction((txApp) => {
      const latest = txApp.findRecordsByFilter(
        'survey_template_versions',
        'template_id = {:tid}',
        '-version',
        1,
        0,
        { tid: template.id },
      );
      const nextVersion = (latest && latest.length > 0 ? latest[0].get('version') : 0) + 1;

      const versionsCol = txApp.findCollectionByNameOrId('survey_template_versions');
      const ver = new Record(versionsCol);
      ver.set('template_id', template.id);
      ver.set('version', nextVersion);
      ver.set('schema_json', { questions: check.questions });
      ver.set('published_at', new Date().toISOString());
      ver.set('published_by', auth.id);
      txApp.save(ver);

      const tpl = txApp.findRecordById('survey_templates', template.id);
      tpl.set('current_version_id', ver.id);
      txApp.save(tpl);

      writeAudit(txApp, {
        actorId: auth.id,
        actorRole: 'super_admin',
        action: 'template.publish',
        targetType: 'survey_template',
        targetId: template.id,
        result: 'success',
        metadata: {
          template_code: template.get('template_code'),
          version: nextVersion,
          question_count: check.questions.length,
        },
      });

      published = { versionId: ver.id, version: nextVersion };
    });
  } catch (err) {
    // 统一错误响应：{ code: <http status>, message, data: { code } }（同 lib/http.pb.js jsonError 形态）
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    // 内部错误细节不回传客户端（仅服务端日志可读）
    return jsonError(e, 500, 'internal_error', '发布新版本失败，请稍后重试');
  }

  return e.json(200, {
    template_id: template.id,
    version: { id: published.versionId, version: published.version, question_count: check.questions.length },
  });
});
