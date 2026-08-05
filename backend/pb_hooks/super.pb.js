// Chat Circles — super.pb.js：超级管理员域 hooks（后端 B）
// 职责（technical-design §5.4/§5.8、PRD §4.2/§12.3、FR-ORG-002/003、AC-23、security-privacy §8/§11）：
// - POST /api/cc/super/invites：生成一次性管理员邀请码。只存 token_hash（sha256），
//   明文仅在本次响应返回一次、不落库（database-design §5.2.2）；默认 7 天有效期
//   （expires_in_days 可调）；写审计 invite.generate（security-privacy §8.1 账号类）。
// - POST /api/cc/super/invites/{id}/revoke：撤销未使用邀请码（4 态机 unused → revoked），
//   写审计 invite.revoke。
// - GET /api/cc/super/backup-status：读取最近一次备份审计（action=backup.*），
//   失败时 alert=true，供超级管理端显著告警（PRD §12.3、AC-23）。
// - POST /api/cc/super/backup/run：手动触发一次备份并写审计（成功 backup.success /
//   失败 backup.failed）；支持 force_fail 故障注入参数（仅用于 AC-23 验收演练）。
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

  let auth;
  try {
    auth = requireAuth(e, 'super');
  } catch (err) {
    return jsonError(e, err.status || 401, (err.data && typeof err.data.code === 'string' ? err.data.code : 'unauthorized'), err.message || '需要超级管理员登录');
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

  let auth;
  try {
    auth = requireAuth(e, 'super');
  } catch (err) {
    return jsonError(e, err.status || 401, (err.data && typeof err.data.code === 'string' ? err.data.code : 'unauthorized'), err.message || '需要超级管理员登录');
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

  const from = invite.get('status');
  invite.set('status', 'revoked');
  $app.save(invite);

  writeAudit($app, {
    actorId: auth.id,
    actorRole: 'super_admin',
    organizationId: invite.get('organization_id'),
    action: 'invite.revoke',
    targetType: 'admin_invite',
    targetId: invite.id,
    result: 'success',
    metadata: { from, to: 'revoked' },
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

  try {
    requireAuth(e, 'super');
  } catch (err) {
    return jsonError(e, err.status || 401, (err.data && typeof err.data.code === 'string' ? err.data.code : 'unauthorized'), err.message || '需要超级管理员登录');
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
  const metadata = decodeJson(last.get('metadata'), null);
  return e.json(200, {
    last_backup: {
      action: last.get('action'),
      result: last.get('result'),
      created: String(last.get('created')).replace(' ', 'T'),
      reason: last.get('reason'),
      file: metadata && metadata.file ? metadata.file : null,
      metadata: metadata,
    },
    alert: failed,
  });
});

// ---------------------------------------------------------------------------
// POST /api/cc/super/backup/run — 手动触发一次备份，写审计；失败时 backup-status 告警
// body: { force_fail?: boolean } — 故障注入，仅供 AC-23 验收演练使用
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/super/backup/run', (e) => {
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

  let auth;
  try {
    auth = requireAuth(e, 'super');
  } catch (err) {
    return jsonError(e, err.status || 401, (err.data && typeof err.data.code === 'string' ? err.data.code : 'unauthorized'), err.message || '需要超级管理员登录');
  }

  const body = e.requestInfo().body || {};
  const startedAt = Date.now();
  const backupName = 'cc_manual_' + new Date().toISOString().replace(/[:.]/g, '-') + '.db';
  let failReason = null;

  try {
    if (body.force_fail === true) {
      throw new Error('故障注入：模拟备份失败（AC-23 演练）');
    }
    // 库文件复制备份：PocketBase 0.28 JSVM 的 createBackup 绑定需要 Go context，hooks 内不可用；
    // 每日一致性快照备份由 Compose backup service（deploy/backup.sh，technical-design §5.8）负责，
    // 本端点为手动触发的一次性备份（尽力而为的库文件复制），结果写审计（PRD §12.3）。
    const dataDir = $app.dataDir();
    $os.mkdirAll(dataDir + '/backups', 0o700);
    const dbBytes = $os.readFile(dataDir + '/data.db');
    $os.writeFile(dataDir + '/backups/' + backupName, dbBytes, 0o600);
  } catch (err) {
    failReason = String(err);
  }

  const durationMs = Date.now() - startedAt;
  writeAudit($app, {
    actorId: auth.id,
    actorRole: 'super_admin',
    action: failReason ? 'backup.failed' : 'backup.success',
    targetType: 'backup',
    targetId: backupName,
    result: failReason ? 'failure' : 'success',
    reason: failReason || undefined,
    metadata: { trigger: 'manual', file: failReason ? undefined : backupName, duration_ms: durationMs },
  });

  if (failReason) {
    return jsonError(e, 500, 'backup_failed', '备份失败：' + failReason);
  }
  return e.json(200, { ok: true, backup: backupName, duration_ms: durationMs });
});
