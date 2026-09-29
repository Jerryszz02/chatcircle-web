// Internal capability: consistent snapshot + fixed backup audit only.
// This key is NOT a PocketBase auth token. Never expose these routes at Caddy.
routerAdd('POST', '/api/cc/internal/backup/snapshot', (e) => {
  const key = $os.getenv('CC_BACKUP_KEY');
  if (key.length < 32 || !$security.equal($security.sha256(e.request.header.get('X-Backup-Key')), $security.sha256(key))) {
    return e.json(403, { message: 'Forbidden' });
  }
  // Generate the name on the server; no caller-controlled path or delete API.
  const name = 'cc_worker_' + $security.randomString(32) + '.zip';
  let fs;
  let created = false;
  try {
    e.app.createBackup(e.request.context(), name);
    created = true;
    fs = e.app.newBackupsFilesystem();
    e.response.header().set('Cache-Control', 'no-store');
    return fs.serve(e.response, e.request, name, name);
  } finally {
    // Delete only our own successfully-created snapshot, including .attrs via FS.
    if (created) {
      if (!fs) fs = e.app.newBackupsFilesystem();
      try { fs.delete(name); } finally { fs.close(); }
    }
  }
});

routerAdd('POST', '/api/cc/internal/backup/result', (e) => {
  const key = $os.getenv('CC_BACKUP_KEY');
  if (key.length < 32 || !$security.equal($security.sha256(e.request.header.get('X-Backup-Key')), $security.sha256(key))) {
    return e.json(403, { message: 'Forbidden' });
  }
  const body = e.requestInfo().body || {};
  if (!['success', 'failure'].includes(body.result) ||
      (body.result === 'success' && (!/^cc_daily_\d{8}_\d{6}_[0-9a-f]{16}\.zip$/.test(body.file || '') || !(body.bytes > 0))) ||
      typeof body.reason !== 'string' || body.reason.length > 200 ||
      !Number.isSafeInteger(body.bytes) || body.bytes < 0 ||
      !Number.isSafeInteger(body.duration_ms) || body.duration_ms < 0) {
    return e.json(400, { message: 'Invalid backup result' });
  }
  const record = new Record(e.app.findCollectionByNameOrId('audit_logs'));
  record.set('actor_id', 'system');
  record.set('actor_role', 'system');
  record.set('action', body.result === 'success' ? 'backup.success' : 'backup.failed');
  record.set('target_type', 'backup');
  record.set('target_id', 'daily');
  record.set('result', body.result);
  record.set('reason', body.reason);
  record.set('metadata', { file: body.result === 'success' ? body.file : '', bytes: body.bytes, duration_ms: body.duration_ms });
  e.app.save(record);
  return e.json(200, { ok: true });
});
