// pairings.pb.js — T2 现场编号、队列、配对、调整与本人配对快照
//
// 冻结契约：docs/planning/api-design.md §4、database-design.md §6.3/§6.4。
// - POST /api/cc/activities/{id}/pairings/start
// - POST /api/cc/activities/{id}/pairings/reassign
// - GET  /api/cc/activities/{id}/my-pairing
// - POST /api/cc/activities/{id}/onsite/lock
//
// checkins 的模型钩子负责在创建 valid 签到的同一事务中分配不可复用现场号；配对已
// 开始时顺带按两侧队首自动补配。valid→revoked 时释放 active pair，现场锁定前把搭档
// 放回队列并继续自动补配，锁定后只释放、不自动调整。

// ---------------------------------------------------------------------------
// 活动创建：所有现场字段都由服务端强制初始化，忽略客户端注入值。
// ---------------------------------------------------------------------------
onRecordCreate((e) => {
  e.record.set('next_speaker_sequence', 1);
  e.record.set('next_listener_sequence', 1);
  for (const field of [
    'pairing_started_at', 'pairing_started_by', 'onsite_locked_at', 'onsite_locked_by',
  ]) {
    e.record.set(field, '');
  }
  e.next();
}, 'activities');

// ---------------------------------------------------------------------------
// 新签到：角色计数器递增 + 现场号写入与签到同事务；配对已开始时自动补齐队列。
// ---------------------------------------------------------------------------
onRecordCreate((e) => {
  const app = e.app;
  const record = e.record;
  // 各 hook 在 PocketBase JSVM 中隔离执行，分页 helper 需放在回调闭包内。
  const queryAll = (queryApp, collection, filter, sort, params) => {
    const configured = Number($os.getenv('CC_PAIRING_PAGE_SIZE'));
    const pageSize = isFinite(configured) && configured > 0
      ? Math.min(Math.floor(configured), 500) : 500;
    const out = [];
    let offset = 0;
    for (;;) {
      const page = queryApp.findRecordsByFilter(
        collection, filter, sort || '', pageSize, offset, params || {},
      );
      if (!page || page.length === 0) break;
      out.push(...page);
      if (page.length < pageSize) break;
      offset += page.length;
    }
    return out;
  };
  if (record.get('status') !== 'valid') {
    e.next();
    return;
  }

  const registration = app.findRecordById('registrations', record.get('registration_id'));
  const activity = app.findRecordById('activities', record.get('activity_id'));
  if (registration.get('activity_id') !== activity.id ||
      registration.get('participant_id') !== record.get('participant_id') ||
      registration.get('status') !== 'approved') {
    throw new ApiError(400, '签到与已通过报名不匹配');
  }
  const role = registration.get('activity_role');
  if (role !== 'speaker' && role !== 'listener') {
    throw new ApiError(400, '报名角色无效，无法分配现场编号');
  }

  const counterField = role === 'speaker' ? 'next_speaker_sequence' : 'next_listener_sequence';
  const sequence = Math.max(1, Number(activity.get(counterField)) || 1);
  record.set('onsite_role', role);
  record.set('onsite_sequence', sequence);
  record.set('numbered_at', new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z');
  activity.set(counterField, sequence + 1);
  app.save(activity);

  // 先保存签到，relation(activity_pairs.*_checkin_id) 才能在同一事务内引用它。
  e.next();

  if ((activity.get('status') !== 'published' && activity.get('status') !== 'closed') ||
      String(activity.get('pairing_started_at') || '') === '') return;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  const actorId = record.get('operator_id') || record.get('participant_id') || 'system';
  const actorRole = record.get('operator_id') ? 'admin' : (record.get('participant_id') ? 'participant' : 'system');
  const activePairs = queryAll(
    app, 'activity_pairs', "activity_id = {:a} && status = 'active'", 'id', { a: activity.id },
  );
  const unavailable = {};
  for (const pair of activePairs) {
    unavailable[pair.get('speaker_checkin_id')] = true;
    unavailable[pair.get('listener_checkin_id')] = true;
  }
  // 锁定后，因撤销而释放的幸存搭档只能经带原因的手工调整重新入组。
  if (String(activity.get('onsite_locked_at') || '') !== '') {
    const releasedPairs = queryAll(
      app, 'activity_pairs', "activity_id = {:a} && status = 'released'", 'id', { a: activity.id },
    );
    for (const pair of releasedPairs) {
      unavailable[pair.get('speaker_checkin_id')] = true;
      unavailable[pair.get('listener_checkin_id')] = true;
    }
  }
  const speakers = queryAll(
    app,
    'checkins', "activity_id = {:a} && status = 'valid' && onsite_role = 'speaker' && onsite_sequence > 0",
    'onsite_sequence', { a: activity.id },
  ).filter((checkin) => !unavailable[checkin.id]);
  const listeners = queryAll(
    app,
    'checkins', "activity_id = {:a} && status = 'valid' && onsite_role = 'listener' && onsite_sequence > 0",
    'onsite_sequence', { a: activity.id },
  ).filter((checkin) => !unavailable[checkin.id]);

  const latest = app.findRecordsByFilter(
    'activity_pairs', 'activity_id = {:a}', '-pair_sequence', 1, 0, { a: activity.id },
  );
  let nextPairSequence = latest.length ? Number(latest[0].get('pair_sequence')) + 1 : 1;
  const count = Math.min(speakers.length, listeners.length);
  for (let i = 0; i < count; i++) {
    const speaker = speakers[i];
    const listener = listeners[i];
    const pair = new Record(app.findCollectionByNameOrId('activity_pairs'));
    pair.set('activity_id', activity.id);
    pair.set('pair_sequence', nextPairSequence++);
    pair.set('speaker_registration_id', speaker.get('registration_id'));
    pair.set('listener_registration_id', listener.get('registration_id'));
    pair.set('speaker_checkin_id', speaker.id);
    pair.set('listener_checkin_id', listener.id);
    pair.set('status', 'active');
    pair.set('paired_at', now);
    pair.set('paired_by', actorId);
    pair.set('adjustment_reason', '');
    app.save(pair);

    const audit = new Record(app.findCollectionByNameOrId('audit_logs'));
    audit.set('actor_id', actorId);
    audit.set('actor_role', actorRole);
    audit.set('organization_id', activity.get('organization_id'));
    audit.set('action', 'pairing.auto');
    audit.set('target_type', 'activity_pair');
    audit.set('target_id', pair.id);
    audit.set('result', 'success');
    audit.set('reason', '');
    audit.set('metadata', { activity_id: activity.id, trigger: 'checkin' });
    app.save(audit);
  }
}, 'checkins');

// ---------------------------------------------------------------------------
// 撤销签到：释放其 active pair；锁定前继续按等待队列补配，锁定后保留人工调整边界。
// ---------------------------------------------------------------------------
onRecordUpdate((e) => {
  const original = e.record.original();
  const isRevocation = original && original.id && original.get('status') === 'valid' &&
    e.record.get('status') === 'revoked';
  let activity = null;
  if (isRevocation) {
    activity = e.app.findRecordById('activities', e.record.get('activity_id'));
    if (activity.get('status') !== 'published' && activity.get('status') !== 'closed') {
      throw new ApiError(400, '活动已终结，不能撤销历史签到');
    }
  }
  e.next();
  if (!isRevocation) return;

  const app = e.app;
  const record = e.record;
  const queryAll = (queryApp, collection, filter, sort, params) => {
    const configured = Number($os.getenv('CC_PAIRING_PAGE_SIZE'));
    const pageSize = isFinite(configured) && configured > 0
      ? Math.min(Math.floor(configured), 500) : 500;
    const out = [];
    let offset = 0;
    for (;;) {
      const page = queryApp.findRecordsByFilter(
        collection, filter, sort || '', pageSize, offset, params || {},
      );
      if (!page || page.length === 0) break;
      out.push(...page);
      if (page.length < pageSize) break;
      offset += page.length;
    }
    return out;
  };
  const now = new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  const actorId = record.get('operator_id') || 'system';
  const actorRole = record.get('operator_id') ? 'admin' : 'system';
  const reason = record.get('reason') || '签到已撤销';
  const pairs = app.findRecordsByFilter(
    'activity_pairs',
    "activity_id = {:a} && status = 'active' && (speaker_checkin_id = {:c} || listener_checkin_id = {:c})",
    '', 10, 0, { a: activity.id, c: record.id },
  );
  for (const pair of pairs) {
    pair.set('status', 'released');
    pair.set('released_at', now);
    pair.set('released_by', actorId);
    pair.set('release_reason', reason);
    app.save(pair);

    const audit = new Record(app.findCollectionByNameOrId('audit_logs'));
    audit.set('actor_id', actorId);
    audit.set('actor_role', actorRole);
    audit.set('organization_id', activity.get('organization_id'));
    audit.set('action', 'pairing.release');
    audit.set('target_type', 'activity_pair');
    audit.set('target_id', pair.id);
    audit.set('result', 'success');
    audit.set('reason', reason);
    audit.set('metadata', { activity_id: activity.id, trigger: 'checkin_revoke' });
    app.save(audit);
  }

  if (String(activity.get('pairing_started_at') || '') === '' ||
      String(activity.get('onsite_locked_at') || '') !== '') return;

  const activePairs = queryAll(
    app, 'activity_pairs', "activity_id = {:a} && status = 'active'", 'id', { a: activity.id },
  );
  const used = {};
  for (const pair of activePairs) {
    used[pair.get('speaker_checkin_id')] = true;
    used[pair.get('listener_checkin_id')] = true;
  }
  const speakers = queryAll(
    app,
    'checkins', "activity_id = {:a} && status = 'valid' && onsite_role = 'speaker' && onsite_sequence > 0",
    'onsite_sequence', { a: activity.id },
  ).filter((checkin) => !used[checkin.id]);
  const listeners = queryAll(
    app,
    'checkins', "activity_id = {:a} && status = 'valid' && onsite_role = 'listener' && onsite_sequence > 0",
    'onsite_sequence', { a: activity.id },
  ).filter((checkin) => !used[checkin.id]);
  const latest = app.findRecordsByFilter(
    'activity_pairs', 'activity_id = {:a}', '-pair_sequence', 1, 0, { a: activity.id },
  );
  let nextPairSequence = latest.length ? Number(latest[0].get('pair_sequence')) + 1 : 1;
  const count = Math.min(speakers.length, listeners.length);
  for (let i = 0; i < count; i++) {
    const pair = new Record(app.findCollectionByNameOrId('activity_pairs'));
    pair.set('activity_id', activity.id);
    pair.set('pair_sequence', nextPairSequence++);
    pair.set('speaker_registration_id', speakers[i].get('registration_id'));
    pair.set('listener_registration_id', listeners[i].get('registration_id'));
    pair.set('speaker_checkin_id', speakers[i].id);
    pair.set('listener_checkin_id', listeners[i].id);
    pair.set('status', 'active');
    pair.set('paired_at', now);
    pair.set('paired_by', actorId);
    pair.set('adjustment_reason', '');
    app.save(pair);

    const audit = new Record(app.findCollectionByNameOrId('audit_logs'));
    audit.set('actor_id', actorId);
    audit.set('actor_role', actorRole);
    audit.set('organization_id', activity.get('organization_id'));
    audit.set('action', 'pairing.auto');
    audit.set('target_type', 'activity_pair');
    audit.set('target_id', pair.id);
    audit.set('result', 'success');
    audit.set('reason', '');
    audit.set('metadata', { activity_id: activity.id, trigger: 'checkin_revoke' });
    app.save(audit);
  }
}, 'checkins');

// ---------------------------------------------------------------------------
// POST /api/cc/activities/{id}/pairings/start — 幂等批量配对/补齐等待队列
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activities/{id}/pairings/start', (e) => {
  try {
    const ccError = (status, code, message) => {
      throw { __ccError: true, status: status, code: code, message: message };
    };
    const isNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
    const byId = (app, collection, id) => {
      try { return app.findRecordById(collection, id); } catch (err) { if (isNoRows(err)) return null; throw err; }
    };
    // 先 limit 再在内存排除已配对者会让第 5001 条以后永久无法进入队列。
    const queryAll = (queryApp, collectionName, filter, sort, params) => {
      const configured = Number($os.getenv('CC_PAIRING_PAGE_SIZE'));
      const pageSize = isFinite(configured) && configured > 0
        ? Math.min(Math.floor(configured), 500) : 500;
      const out = [];
      let offset = 0;
      for (;;) {
        const page = queryApp.findRecordsByFilter(
          collectionName, filter, sort || '', pageSize, offset, params || {},
        );
        if (!page || page.length === 0) break;
        out.push(...page);
        if (page.length < pageSize) break;
        offset += page.length;
      }
      return out;
    };
    const auth = e.auth;
    if (!auth) ccError(401, 'unauthorized', '请先登录');
    const collection = auth.collection().name;
    let actorRole = '';
    let orgId = '';
    if (collection === 'admin_accounts') {
      if (auth.get('status') !== 'active') ccError(403, 'account_disabled', '账号已停用');
      orgId = auth.get('organization_id');
      const org = byId($app, 'organizations', orgId);
      if (!org || org.get('status') !== 'active') ccError(403, 'org_disabled', '所属机构已停用');
      actorRole = 'admin';
    } else if (collection === '_superusers') {
      actorRole = 'super_admin';
    } else {
      ccError(403, 'forbidden', '无权限：需要机构管理员或超级管理员身份');
    }

    const activityId = e.request.pathValue('id');
    const visibleActivity = byId($app, 'activities', activityId);
    if (!visibleActivity || (actorRole === 'admin' && visibleActivity.get('organization_id') !== orgId)) {
      ccError(404, 'not_found', '活动不存在');
    }
    const isBusy = (err) => !!err && /busy|locked|snapshot/i.test(String((err && err.message) || err));
    let alreadyStarted = false;
    let createdPairs = 0;
    let activeCount = 0;
    let waiting = { total: 0, speaker: 0, listener: 0 };
    let attempts = 0;
    for (;;) {
      try {
        $app.runInTransaction((txApp) => {
          const activity = txApp.findRecordById('activities', activityId);
          if (activity.get('status') !== 'published' && activity.get('status') !== 'closed') {
            ccError(400, 'pairing_unavailable', '活动当前不可开始配对');
          }
          alreadyStarted = String(activity.get('pairing_started_at') || '') !== '';
          const now = new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
          if (!alreadyStarted) {
            activity.set('pairing_started_at', now);
            activity.set('pairing_started_by', auth.id);
            txApp.save(activity);
          }

          const activePairs = queryAll(
            txApp, 'activity_pairs', "activity_id = {:a} && status = 'active'", 'id', { a: activityId },
          );
          const unavailable = {};
          for (const pair of activePairs) {
            unavailable[pair.get('speaker_checkin_id')] = true;
            unavailable[pair.get('listener_checkin_id')] = true;
          }
          if (String(activity.get('onsite_locked_at') || '') !== '') {
            const releasedPairs = queryAll(
              txApp, 'activity_pairs', "activity_id = {:a} && status = 'released'", 'id', { a: activityId },
            );
            for (const pair of releasedPairs) {
              unavailable[pair.get('speaker_checkin_id')] = true;
              unavailable[pair.get('listener_checkin_id')] = true;
            }
          }
          const speakers = queryAll(
            txApp,
            'checkins', "activity_id = {:a} && status = 'valid' && onsite_role = 'speaker' && onsite_sequence > 0",
            'onsite_sequence', { a: activityId },
          ).filter((checkin) => !unavailable[checkin.id]);
          const listeners = queryAll(
            txApp,
            'checkins', "activity_id = {:a} && status = 'valid' && onsite_role = 'listener' && onsite_sequence > 0",
            'onsite_sequence', { a: activityId },
          ).filter((checkin) => !unavailable[checkin.id]);
          const latest = txApp.findRecordsByFilter(
            'activity_pairs', 'activity_id = {:a}', '-pair_sequence', 1, 0, { a: activityId },
          );
          let nextSequence = latest.length ? Number(latest[0].get('pair_sequence')) + 1 : 1;
          createdPairs = Math.min(speakers.length, listeners.length);
          for (let i = 0; i < createdPairs; i++) {
            const pair = new Record(txApp.findCollectionByNameOrId('activity_pairs'));
            pair.set('activity_id', activityId);
            pair.set('pair_sequence', nextSequence++);
            pair.set('speaker_registration_id', speakers[i].get('registration_id'));
            pair.set('listener_registration_id', listeners[i].get('registration_id'));
            pair.set('speaker_checkin_id', speakers[i].id);
            pair.set('listener_checkin_id', listeners[i].id);
            pair.set('status', 'active');
            pair.set('paired_at', now);
            pair.set('paired_by', auth.id);
            pair.set('adjustment_reason', '');
            txApp.save(pair);
          }

          activeCount = activePairs.length + createdPairs;
          waiting.speaker = speakers.length - createdPairs;
          waiting.listener = listeners.length - createdPairs;
          waiting.total = waiting.speaker + waiting.listener;

          if (!alreadyStarted || createdPairs > 0) {
            const audit = new Record(txApp.findCollectionByNameOrId('audit_logs'));
            audit.set('actor_id', auth.id);
            audit.set('actor_role', actorRole);
            audit.set('organization_id', activity.get('organization_id'));
            audit.set('action', 'pairing.start');
            audit.set('target_type', 'activity');
            audit.set('target_id', activityId);
            audit.set('result', 'success');
            audit.set('reason', '');
            audit.set('metadata', { created_pairs: createdPairs, already_started: alreadyStarted });
            txApp.save(audit);
          }
        });
        break;
      } catch (err) {
        if (err && err.__ccError === true) throw err;
        if (isBusy(err) && attempts < 2) { attempts++; continue; }
        if (isBusy(err)) ccError(409, 'conflict', '配对操作冲突，请稍后重试');
        throw err;
      }
    }

    return e.json(200, {
      contract_version: '2026-08-28.t0-v1',
      activity_id: activityId,
      already_started: alreadyStarted,
      created_pairs: createdPairs,
      active_pairs: activeCount,
      waiting: waiting,
    });
  } catch (err) {
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/activities/{id}/pairings/reassign — 原子释放涉及组并建立指定新组
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activities/{id}/pairings/reassign', (e) => {
  try {
    const ccError = (status, code, message) => {
      throw { __ccError: true, status: status, code: code, message: message };
    };
    const isNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
    const byId = (app, collection, id) => {
      try { return app.findRecordById(collection, id); } catch (err) { if (isNoRows(err)) return null; throw err; }
    };
    const pairJson = (pair) => ({
      id: pair.id, created: pair.get('created'), updated: pair.get('updated'),
      activity_id: pair.get('activity_id'), pair_sequence: pair.get('pair_sequence'),
      speaker_registration_id: pair.get('speaker_registration_id'),
      listener_registration_id: pair.get('listener_registration_id'),
      speaker_checkin_id: pair.get('speaker_checkin_id'),
      listener_checkin_id: pair.get('listener_checkin_id'), status: pair.get('status'),
      paired_at: pair.get('paired_at'), paired_by: pair.get('paired_by'),
      adjustment_reason: pair.get('adjustment_reason') || undefined,
      released_at: pair.get('released_at') || undefined,
      released_by: pair.get('released_by') || undefined,
      release_reason: pair.get('release_reason') || undefined,
      completed_at: pair.get('completed_at') || undefined,
    });
    const auth = e.auth;
    if (!auth) ccError(401, 'unauthorized', '请先登录');
    const collection = auth.collection().name;
    let actorRole = '';
    let orgId = '';
    if (collection === 'admin_accounts') {
      if (auth.get('status') !== 'active') ccError(403, 'account_disabled', '账号已停用');
      orgId = auth.get('organization_id');
      const org = byId($app, 'organizations', orgId);
      if (!org || org.get('status') !== 'active') ccError(403, 'org_disabled', '所属机构已停用');
      actorRole = 'admin';
    } else if (collection === '_superusers') {
      actorRole = 'super_admin';
    } else {
      ccError(403, 'forbidden', '无权限：需要机构管理员或超级管理员身份');
    }
    const activityId = e.request.pathValue('id');
    const visibleActivity = byId($app, 'activities', activityId);
    if (!visibleActivity || (actorRole === 'admin' && visibleActivity.get('organization_id') !== orgId)) {
      ccError(404, 'not_found', '活动不存在');
    }
    const body = e.requestInfo().body || {};
    const speakerId = typeof body.speaker_checkin_id === 'string' ? body.speaker_checkin_id : '';
    const listenerId = typeof body.listener_checkin_id === 'string' ? body.listener_checkin_id : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!speakerId || !listenerId) ccError(400, 'validation_failed', '必须选择倾诉者和聆听者签到记录');
    if (!reason) ccError(400, 'reason_required', '手工调整必须填写原因');

    const isBusy = (err) => !!err && /busy|locked|snapshot/i.test(String((err && err.message) || err));
    let releasedIds = [];
    let resultPair = null;
    let attempts = 0;
    for (;;) {
      try {
        $app.runInTransaction((txApp) => {
          const activity = txApp.findRecordById('activities', activityId);
          if (activity.get('status') !== 'published' && activity.get('status') !== 'closed') {
            ccError(400, 'pairing_unavailable', '活动当前状态不可调整配对');
          }
          if (String(activity.get('pairing_started_at') || '') === '') {
            ccError(409, 'pairing_not_started', '请先开始配对');
          }
          const speaker = byId(txApp, 'checkins', speakerId);
          const listener = byId(txApp, 'checkins', listenerId);
          if (!speaker || !listener || speaker.get('activity_id') !== activityId ||
              listener.get('activity_id') !== activityId) {
            ccError(404, 'not_found', '签到记录不存在');
          }
          if (speaker.get('status') !== 'valid' || listener.get('status') !== 'valid' ||
              speaker.get('onsite_role') !== 'speaker' || listener.get('onsite_role') !== 'listener' ||
              Number(speaker.get('onsite_sequence')) < 1 || Number(listener.get('onsite_sequence')) < 1) {
            ccError(400, 'invalid_pairing_members', '只能调整同场有效且已编号的倾诉者与聆听者');
          }
          if (speaker.get('participant_id') === listener.get('participant_id')) {
            ccError(400, 'invalid_pairing_members', '同一参与者不能与自己配对');
          }

          const existingTogether = txApp.findRecordsByFilter(
            'activity_pairs',
            "activity_id = {:a} && status = 'active' && speaker_checkin_id = {:s} && listener_checkin_id = {:l}",
            '', 1, 0, { a: activityId, s: speakerId, l: listenerId },
          );
          if (existingTogether.length) {
            resultPair = existingTogether[0];
            releasedIds = [];
            return;
          }

          const involved = txApp.findRecordsByFilter(
            'activity_pairs',
            "activity_id = {:a} && status = 'active' && (speaker_checkin_id = {:s} || listener_checkin_id = {:l})",
            '', 10, 0, { a: activityId, s: speakerId, l: listenerId },
          );
          const now = new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
          releasedIds = [];
          for (const pair of involved) {
            pair.set('status', 'released');
            pair.set('released_at', now);
            pair.set('released_by', auth.id);
            pair.set('release_reason', reason);
            txApp.save(pair);
            releasedIds.push(pair.id);

            const releaseAudit = new Record(txApp.findCollectionByNameOrId('audit_logs'));
            releaseAudit.set('actor_id', auth.id);
            releaseAudit.set('actor_role', actorRole);
            releaseAudit.set('organization_id', activity.get('organization_id'));
            releaseAudit.set('action', 'pairing.release');
            releaseAudit.set('target_type', 'activity_pair');
            releaseAudit.set('target_id', pair.id);
            releaseAudit.set('result', 'success');
            releaseAudit.set('reason', reason);
            releaseAudit.set('metadata', { activity_id: activityId, trigger: 'reassign' });
            txApp.save(releaseAudit);
          }

          const latest = txApp.findRecordsByFilter(
            'activity_pairs', 'activity_id = {:a}', '-pair_sequence', 1, 0, { a: activityId },
          );
          const nextSequence = latest.length ? Number(latest[0].get('pair_sequence')) + 1 : 1;
          resultPair = new Record(txApp.findCollectionByNameOrId('activity_pairs'));
          resultPair.set('activity_id', activityId);
          resultPair.set('pair_sequence', nextSequence);
          resultPair.set('speaker_registration_id', speaker.get('registration_id'));
          resultPair.set('listener_registration_id', listener.get('registration_id'));
          resultPair.set('speaker_checkin_id', speaker.id);
          resultPair.set('listener_checkin_id', listener.id);
          resultPair.set('status', 'active');
          resultPair.set('paired_at', now);
          resultPair.set('paired_by', auth.id);
          resultPair.set('adjustment_reason', reason);
          txApp.save(resultPair);

          const audit = new Record(txApp.findCollectionByNameOrId('audit_logs'));
          audit.set('actor_id', auth.id);
          audit.set('actor_role', actorRole);
          audit.set('organization_id', activity.get('organization_id'));
          audit.set('action', 'pairing.reassign');
          audit.set('target_type', 'activity_pair');
          audit.set('target_id', resultPair.id);
          audit.set('result', 'success');
          audit.set('reason', reason);
          audit.set('metadata', { activity_id: activityId, released_pair_ids: releasedIds });
          txApp.save(audit);
        });
        break;
      } catch (err) {
        if (err && err.__ccError === true) throw err;
        if (isBusy(err) && attempts < 2) { attempts++; continue; }
        if (isBusy(err)) ccError(409, 'conflict', '调整操作冲突，请稍后重试');
        throw err;
      }
    }

    return e.json(200, {
      contract_version: '2026-08-28.t0-v1',
      activity_id: activityId,
      released_pair_ids: releasedIds,
      pairing: pairJson(resultPair),
    });
  } catch (err) {
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /api/cc/activities/{id}/my-pairing — 只返回当前参与者本人的最小配对信息
// ---------------------------------------------------------------------------
routerAdd('GET', '/api/cc/activities/{id}/my-pairing', (e) => {
  try {
    const ccError = (status, code, message) => {
      throw { __ccError: true, status: status, code: code, message: message };
    };
    const isNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
    const one = (app, collection, filter, params, sort) => {
      const rows = app.findRecordsByFilter(collection, filter, sort || '', 1, 0, params || {});
      return rows.length ? rows[0] : null;
    };
    const jsonValue = (value, fallback) => {
      try {
        const parsed = JSON.parse(String(value == null ? '' : value));
        return parsed == null ? fallback : parsed;
      } catch (_) {
        return fallback;
      }
    };
    const auth = e.auth;
    if (!auth) ccError(401, 'unauthorized', '请先登录');
    if (auth.collection().name !== 'participant_accounts') {
      ccError(403, 'forbidden', '无权限：需要参与者身份');
    }
    if (auth.get('status') !== 'active') ccError(403, 'account_disabled', '账号已停用');
    const activityId = e.request.pathValue('id');
    let activity = null;
    try { activity = $app.findRecordById('activities', activityId); } catch (err) { if (!isNoRows(err)) throw err; }
    const registration = one(
      $app, 'registrations', 'activity_id = {:a} && participant_id = {:p}',
      { a: activityId, p: auth.id }, '',
    );
    if (!activity || !registration) ccError(404, 'not_found', '活动或本人报名不存在');

    const now = new Date().toISOString();
    const response = {
      contract_version: '2026-08-28.t0-v1',
      activity_id: activityId,
      state: 'not_checked_in',
      updated_at: now,
    };
    const valid = one(
      $app, 'checkins', "activity_id = {:a} && participant_id = {:p} && status = 'valid'",
      { a: activityId, p: auth.id }, '-created',
    );
    if (!valid) {
      const revoked = one(
        $app, 'checkins', "activity_id = {:a} && participant_id = {:p} && status = 'revoked'",
        { a: activityId, p: auth.id }, '-created',
      );
      if (revoked) {
        response.state = 'checkin_revoked';
        if (Number(revoked.get('onsite_sequence')) > 0) {
          response.onsite_code = (revoked.get('onsite_role') === 'speaker' ? 'S' : 'L') +
            String(revoked.get('onsite_sequence')).padStart(2, '0');
        }
      }
      return e.json(200, response);
    }

    if (Number(valid.get('onsite_sequence')) > 0) {
      response.onsite_code = (valid.get('onsite_role') === 'speaker' ? 'S' : 'L') +
        String(valid.get('onsite_sequence')).padStart(2, '0');
    }
    if (String(activity.get('pairing_started_at') || '') === '') {
      response.state = 'waiting_to_start';
      return e.json(200, response);
    }

    const pair = one(
      $app, 'activity_pairs',
      "activity_id = {:a} && status = 'active' && (speaker_checkin_id = {:c} || listener_checkin_id = {:c})",
      { a: activityId, c: valid.id }, '-created',
    );
    if (!pair) {
      response.state = 'waiting_for_partner';
      return e.json(200, response);
    }

    const isSpeaker = pair.get('speaker_checkin_id') === valid.id;
    const partnerCheckinId = isSpeaker ? pair.get('listener_checkin_id') : pair.get('speaker_checkin_id');
    const partnerCheckin = $app.findRecordById('checkins', partnerCheckinId);
    const partnerRegistrationId = isSpeaker
      ? pair.get('listener_registration_id') : pair.get('speaker_registration_id');
    let displayName = '';
    const fullNameDef = one(
      $app, 'registration_field_defs',
      "organization_id = '' && source_type = 'standard' && field_code = 'FULL_NAME'",
      {}, 'created',
    );
    if (fullNameDef) {
      const answer = one(
        $app, 'registration_answers', 'registration_id = {:r} && field_def_id = {:f}',
        { r: partnerRegistrationId, f: fullNameDef.id }, '',
      );
      const value = answer ? jsonValue(answer.get('value_json'), '') : '';
      if (typeof value === 'string') displayName = value;
    }
    const releasedHistory = one(
      $app, 'activity_pairs',
      "activity_id = {:a} && status = 'released' && (speaker_checkin_id = {:c} || listener_checkin_id = {:c})",
      { a: activityId, c: valid.id }, '-released_at',
    );
    response.state = pair.get('adjustment_reason') || releasedHistory ? 'reassigned' : 'paired';
    response.pair_code = 'P' + String(pair.get('pair_sequence')).padStart(2, '0');
    response.partner = {
      onsite_code: (partnerCheckin.get('onsite_role') === 'speaker' ? 'S' : 'L') +
        String(partnerCheckin.get('onsite_sequence')).padStart(2, '0'),
      display_name: displayName,
    };
    return e.json(200, response);
  } catch (err) {
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/cc/activities/{id}/onsite/lock — 幂等锁定“活动已开始”事实
// ---------------------------------------------------------------------------
routerAdd('POST', '/api/cc/activities/{id}/onsite/lock', (e) => {
  try {
    const ccError = (status, code, message) => {
      throw { __ccError: true, status: status, code: code, message: message };
    };
    const isNoRows = (err) => !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
    const byId = (app, collection, id) => {
      try { return app.findRecordById(collection, id); } catch (err) { if (isNoRows(err)) return null; throw err; }
    };
    const auth = e.auth;
    if (!auth) ccError(401, 'unauthorized', '请先登录');
    const collection = auth.collection().name;
    let actorRole = '';
    let orgId = '';
    if (collection === 'admin_accounts') {
      if (auth.get('status') !== 'active') ccError(403, 'account_disabled', '账号已停用');
      orgId = auth.get('organization_id');
      const org = byId($app, 'organizations', orgId);
      if (!org || org.get('status') !== 'active') ccError(403, 'org_disabled', '所属机构已停用');
      actorRole = 'admin';
    } else if (collection === '_superusers') {
      actorRole = 'super_admin';
    } else {
      ccError(403, 'forbidden', '无权限：需要机构管理员或超级管理员身份');
    }
    const activityId = e.request.pathValue('id');
    const visibleActivity = byId($app, 'activities', activityId);
    if (!visibleActivity || (actorRole === 'admin' && visibleActivity.get('organization_id') !== orgId)) {
      ccError(404, 'not_found', '活动不存在');
    }

    const isBusy = (err) => !!err && /busy|locked|snapshot/i.test(String((err && err.message) || err));
    let alreadyLocked = false;
    let onsite = null;
    let attempts = 0;
    for (;;) {
      try {
        $app.runInTransaction((txApp) => {
          const activity = txApp.findRecordById('activities', activityId);
          if (activity.get('status') !== 'published' && activity.get('status') !== 'closed') {
            ccError(400, 'onsite_unavailable', '活动当前不可锁定现场安排');
          }
          alreadyLocked = String(activity.get('onsite_locked_at') || '') !== '';
          if (!alreadyLocked) {
            activity.set('onsite_locked_at', new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z');
            activity.set('onsite_locked_by', auth.id);
            txApp.save(activity);

            const audit = new Record(txApp.findCollectionByNameOrId('audit_logs'));
            audit.set('actor_id', auth.id);
            audit.set('actor_role', actorRole);
            audit.set('organization_id', activity.get('organization_id'));
            audit.set('action', 'onsite.lock');
            audit.set('target_type', 'activity');
            audit.set('target_id', activityId);
            audit.set('result', 'success');
            audit.set('reason', '');
            audit.set('metadata', {
              pairing_started: String(activity.get('pairing_started_at') || '') !== '',
            });
            txApp.save(audit);
          }
          onsite = {
            pairing_started_at: String(activity.get('pairing_started_at') || '') || undefined,
            pairing_started_by: String(activity.get('pairing_started_by') || '') || undefined,
            onsite_locked_at: String(activity.get('onsite_locked_at') || '') || undefined,
            onsite_locked_by: String(activity.get('onsite_locked_by') || '') || undefined,
          };
        });
        break;
      } catch (err) {
        if (err && err.__ccError === true) throw err;
        if (isBusy(err) && attempts < 2) { attempts++; continue; }
        if (isBusy(err)) ccError(409, 'conflict', '现场锁定冲突，请稍后重试');
        throw err;
      }
    }

    return e.json(200, {
      contract_version: '2026-08-28.t0-v1',
      activity_id: activityId,
      already_locked: alreadyLocked,
      onsite: onsite,
    });
  } catch (err) {
    if (err && err.__ccError === true) {
      return e.json(err.status, { code: err.status, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});
