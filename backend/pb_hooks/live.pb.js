// Chat Circles — T3 单活动实时快照与 Realtime 最小权限守卫
//
// 冻结契约：docs/planning/api-design.md §4/§5、frontend/src/shared/api/accountEvent.ts。
// - GET /api/cc/activities/{id}/live-summary：admin 仅本机构，super 可跨机构；跨机构与不存在统一 404。
// - 快照是指标唯一事实来源；Realtime record/custom message 只作为“数据已变更”信号。
// - T3 与 T2 并行：activity_pairs/现场字段尚未迁入时返回兼容的 0/空状态；T2 合入后自动纳入。
// - participant 禁止直订 activity_pairs；本人 pairing topic 与 auth id 强绑定。
//
// PocketBase 0.28.4 的 JSVM handler 作用域彼此隔离，因此路由所需工具函数全部内联。

routerAdd('GET', '/api/cc/activities/{id}/live-summary', (e) => {
  try {
    const CONTRACT_VERSION = '2026-08-28.t0-v1';
    const ccError = (status, code, message) => {
      throw { __ccError: true, status: status, code: code, message: message };
    };
    const ccIsNoRows = (err) =>
      !!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0;
    const ccById = (app, collection, id) => {
      try {
        return app.findRecordById(collection, id);
      } catch (err) {
        if (ccIsNoRows(err)) return null;
        throw err;
      }
    };
    const hasCollection = (app, name) => {
      try {
        app.findCollectionByNameOrId(name);
        return true;
      } catch (_) {
        return false;
      }
    };
    const queryAll = (app, collection, filter, params, sort) => {
      const out = [];
      const pageSize = 500;
      let offset = 0;
      for (;;) {
        const page = app.findRecordsByFilter(
          collection,
          filter || '',
          sort || '',
          pageSize,
          offset,
          params || {},
        );
        if (!page || page.length === 0) break;
        out.push(...page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }
      return out;
    };
    const iso = (value) => (value ? String(value).replace(' ', 'T') : '');
    const ccJson = (value, fallback) => {
      if (value === null || value === undefined || value === '') return fallback;
      let encoded = value;
      if (Array.isArray(value) && (value.length === 0 || typeof value[0] === 'number')) {
        let decoded = '';
        let index = 0;
        while (index < value.length) {
          const byte = value[index];
          if (byte < 0x80) {
            decoded += String.fromCharCode(byte);
            index += 1;
          } else if (byte < 0xe0) {
            decoded += String.fromCharCode(((byte & 0x1f) << 6) | (value[index + 1] & 0x3f));
            index += 2;
          } else if (byte < 0xf0) {
            decoded += String.fromCharCode(
              ((byte & 0x0f) << 12) |
                ((value[index + 1] & 0x3f) << 6) |
                (value[index + 2] & 0x3f),
            );
            index += 3;
          } else {
            let codePoint =
              ((byte & 0x07) << 18) |
              ((value[index + 1] & 0x3f) << 12) |
              ((value[index + 2] & 0x3f) << 6) |
              (value[index + 3] & 0x3f);
            codePoint -= 0x10000;
            decoded += String.fromCharCode(
              0xd800 + (codePoint >> 10),
              0xdc00 + (codePoint & 0x3ff),
            );
            index += 4;
          }
        }
        encoded = decoded;
      }
      try {
        const parsed = JSON.parse(String(encoded));
        return parsed == null ? fallback : parsed;
      } catch (_) {
        return fallback;
      }
    };
    const emptyRoleCounts = () => ({ total: 0, speaker: 0, listener: 0 });
    const incrementRole = (counts, role) => {
      if (role !== 'speaker' && role !== 'listener') return;
      counts.total += 1;
      counts[role] += 1;
    };
    const ratio = (numerator, denominator) => {
      if (denominator === 0) return null;
      return Math.max(0, Math.min(1, numerator / denominator));
    };
    const completion = (eligibleIds, submittedRegistrationIds) => {
      let submitted = 0;
      for (const registrationId in eligibleIds) {
        if (submittedRegistrationIds[registrationId]) submitted += 1;
      }
      const eligible = Object.keys(eligibleIds).length;
      return { eligible: eligible, submitted: submitted, rate: ratio(submitted, eligible) };
    };
    const suppressedBuckets = (counts) => {
      const keys = Object.keys(counts).sort();
      // 任一小桶都必须连同同维度的互补桶一起隐藏，否则可用 approved.total
      // 减去其余可见桶，反推出小桶的精确人数。
      const suppressDimension = keys.some((key) => counts[key] < 5);
      return keys.map((key) => ({
        key: key,
        count: suppressDimension ? null : counts[key],
        suppressed: suppressDimension,
      }));
    };
    const onsiteCode = (role, sequence) => {
      const n = Number(sequence || 0);
      if ((role !== 'speaker' && role !== 'listener') || !Number.isFinite(n) || n <= 0) return '';
      return (role === 'speaker' ? 'S' : 'L') + String(Math.trunc(n)).padStart(2, '0');
    };

    const auth = e.auth;
    if (!auth) ccError(401, 'unauthorized', '需要机构管理员或超级管理员登录');
    const authCollection = auth.collection().name;
    let role = '';
    let organizationId = '';
    if (authCollection === 'admin_accounts') {
      if (auth.get('status') !== 'active') ccError(403, 'account_disabled', '账号已停用');
      const org = ccById($app, 'organizations', auth.get('organization_id'));
      if (!org || org.get('status') !== 'active') ccError(403, 'org_disabled', '所属机构已停用');
      role = 'admin';
      organizationId = auth.get('organization_id');
    } else if (authCollection === '_superusers') {
      role = 'super';
    } else {
      ccError(401, 'unauthorized', '需要机构管理员或超级管理员登录');
    }

    let summary = null;
    $app.runInTransaction((txApp) => {
      const activityId = e.request.pathValue('id');
      const activity = ccById(txApp, 'activities', activityId);
      if (!activity || (role === 'admin' && activity.get('organization_id') !== organizationId)) {
        ccError(404, 'not_found', '活动不存在');
      }

      const registrations = queryAll(
        txApp,
        'registrations',
        'activity_id = {:activity}',
        { activity: activityId },
        'created',
      );
      const registrationsById = {};
      const registrationFunnel = {
        total: emptyRoleCounts(),
        pending: emptyRoleCounts(),
        approved: emptyRoleCounts(),
        rejected: emptyRoleCounts(),
        cancelled: emptyRoleCounts(),
      };
      for (const registration of registrations) {
        registrationsById[registration.id] = registration;
        const registrationRole = registration.get('activity_role');
        incrementRole(registrationFunnel.total, registrationRole);
        const status = registration.get('status');
        if (registrationFunnel[status]) incrementRole(registrationFunnel[status], registrationRole);
      }

      const checkins = queryAll(
        txApp,
        'checkins',
        'activity_id = {:activity}',
        { activity: activityId },
        '-checked_in_at',
      );
      const validCheckins = [];
      const validCheckinsByRegistration = {};
      const checkinApproved = emptyRoleCounts();
      const checkinValid = emptyRoleCounts();
      for (const registration of registrations) {
        if (registration.get('status') === 'approved') {
          incrementRole(checkinApproved, registration.get('activity_role'));
        }
      }
      for (const checkin of checkins) {
        if (checkin.get('status') !== 'valid') continue;
        const registration = registrationsById[checkin.get('registration_id')];
        const checkinRole = checkin.get('onsite_role') || (registration && registration.get('activity_role'));
        incrementRole(checkinValid, checkinRole);
        validCheckins.push(checkin);
        if (registration) validCheckinsByRegistration[registration.id] = true;
      }

      let activePairs = [];
      if (hasCollection(txApp, 'activity_pairs')) {
        activePairs = queryAll(
          txApp,
          'activity_pairs',
          "activity_id = {:activity} && status = 'active'",
          { activity: activityId },
          'pair_sequence',
        );
      }
      const pairedCheckinIds = {};
      for (const pair of activePairs) {
        pairedCheckinIds[pair.get('speaker_checkin_id')] = true;
        pairedCheckinIds[pair.get('listener_checkin_id')] = true;
      }
      const waiting = emptyRoleCounts();
      for (const checkin of validCheckins) {
        if (pairedCheckinIds[checkin.id]) continue;
        const registration = registrationsById[checkin.get('registration_id')];
        incrementRole(waiting, checkin.get('onsite_role') || (registration && registration.get('activity_role')));
      }

      const activitySurveys = queryAll(
        txApp,
        'activity_surveys',
        'activity_id = {:activity}',
        { activity: activityId },
        'created',
      );
      const surveySummaries = [];
      for (const survey of activitySurveys) {
        const roleScope = survey.get('role_scope') || 'both';
        const roleMatches = (registration) =>
          roleScope === 'both' || registration.get('activity_role') === roleScope;
        const overallEligible = {};
        const onsiteEligible = {};
        for (const registration of registrations) {
          if (!roleMatches(registration)) continue;
          if (registration.get('status') === 'approved') overallEligible[registration.id] = true;
          if (validCheckinsByRegistration[registration.id]) onsiteEligible[registration.id] = true;
        }
        const submissions = queryAll(
          txApp,
          'submissions',
          "activity_survey_id = {:survey} && status = 'submitted'",
          { survey: survey.id },
          'created',
        );
        const submittedRegistrationIds = {};
        for (const submission of submissions) {
          submittedRegistrationIds[submission.get('registration_id')] = true;
        }
        surveySummaries.push({
          activity_survey_id: survey.id,
          title: survey.get('title'),
          onsite_completion: completion(onsiteEligible, submittedRegistrationIds),
          overall_completion: completion(overallEligible, submittedRegistrationIds),
        });
      }

      const fieldDefs = queryAll(
        txApp,
        'registration_field_defs',
        "(organization_id = '' || organization_id = {:organization}) && " +
          "(field_code = 'FULL_NAME' || field_code = 'GENDER' || field_code = 'AGE_RANGE')",
        { organization: activity.get('organization_id') },
        'created',
      );
      const fieldCodesById = {};
      for (const fieldDef of fieldDefs) fieldCodesById[fieldDef.id] = fieldDef.get('field_code');
      const targetAnswers = queryAll(
        txApp,
        'registration_answers',
        'registration_id.activity_id = {:activity}',
        { activity: activityId },
        'created',
      );
      const valuesByRegistration = {};
      for (const answer of targetAnswers) {
        const code = fieldCodesById[answer.get('field_def_id')];
        if (!code) continue;
        const value = ccJson(answer.get('value_json'), null);
        if (typeof value !== 'string' || value === '') continue;
        if (!valuesByRegistration[answer.get('registration_id')]) {
          valuesByRegistration[answer.get('registration_id')] = {};
        }
        valuesByRegistration[answer.get('registration_id')][code] = value;
      }

      const genderCounts = {};
      const ageRangeCounts = {};
      for (const registration of registrations) {
        if (registration.get('status') !== 'approved') continue;
        const values = valuesByRegistration[registration.id] || {};
        const gender = values.GENDER || 'unknown';
        const ageRange = values.AGE_RANGE || 'unknown';
        genderCounts[gender] = (genderCounts[gender] || 0) + 1;
        ageRangeCounts[ageRange] = (ageRangeCounts[ageRange] || 0) + 1;
      }

      const recentCheckins = checkins.slice(0, 20).map((checkin) => {
        const registration = registrationsById[checkin.get('registration_id')];
        const values = registration ? valuesByRegistration[registration.id] || {} : {};
        const checkinRole = checkin.get('onsite_role') || (registration && registration.get('activity_role'));
        return {
          checkin_id: checkin.id,
          participant_id: checkin.get('participant_id'),
          display_name: values.FULL_NAME || '',
          onsite_code: onsiteCode(checkinRole, checkin.get('onsite_sequence')),
          checked_in_at: iso(checkin.get('checked_in_at')),
          status: checkin.get('status'),
        };
      });

      const onsite = {};
      const onsiteFields = [
        'pairing_started_at',
        'pairing_started_by',
        'onsite_locked_at',
        'onsite_locked_by',
      ];
      for (const field of onsiteFields) {
        const value = activity.get(field);
        if (value) onsite[field] = field.endsWith('_at') ? iso(value) : value;
      }

      summary = {
        contract_version: CONTRACT_VERSION,
        activity_id: activityId,
        generated_at: new Date().toISOString(),
        onsite: onsite,
        registrations: registrationFunnel,
        checkins: {
          approved: checkinApproved,
          valid: checkinValid,
          rate: {
            total: ratio(checkinValid.total, checkinApproved.total),
            speaker: ratio(checkinValid.speaker, checkinApproved.speaker),
            listener: ratio(checkinValid.listener, checkinApproved.listener),
          },
        },
        pairings: {
          active_pairs: activePairs.length,
          waiting: waiting,
          imbalance: Math.abs(waiting.speaker - waiting.listener),
        },
        surveys: surveySummaries,
        demographics: {
          suppression_threshold: 5,
          gender: suppressedBuckets(genderCounts),
          age_range: suppressedBuckets(ageRangeCounts),
        },
        recent_checkins: recentCheckins,
      };
    });

    return e.json(200, summary);
  } catch (err) {
    if (err && err.__ccError === true) {
      return e.json(err.status, {
        code: err.status,
        message: err.message,
        data: { code: err.code },
      });
    }
    throw err;
  }
});

// pairing 自定义 topic 只能由对应 participant 订阅；participant 也不得直订 pair records。
onRealtimeSubscribeRequest((e) => {
  const pairingPrefix = 'cc.participant.pairing.';
  const auth = e.auth;
  const authCollection = auth ? auth.collection().name : '';
  for (const rawSubscription of e.subscriptions || []) {
    const topic = String(rawSubscription).split('?')[0];
    if (topic === 'activity_pairs' || topic.indexOf('activity_pairs/') === 0) {
      if (authCollection === 'participant_accounts') {
        throw new ForbiddenError('参与者不能订阅活动配对记录');
      }
      continue;
    }
    if (topic.indexOf(pairingPrefix) !== 0) continue;
    const participantId = topic.slice(pairingPrefix.length);
    if (
      authCollection !== 'participant_accounts' ||
      auth.get('status') !== 'active' ||
      participantId !== auth.id
    ) {
      throw new ForbiddenError('只能订阅本人的配对状态');
    }
  }
  e.next();
});

// 自定义 pairing 消息发送前再次按连接 auth 过滤，并把 payload 收窄到冻结的失效化字段。
onRealtimeMessageSend((e) => {
  // Realtime keeps an authentication snapshot. Refresh it for every outgoing
  // record/custom message so deactivation also closes existing subscriptions.
  const clientAuth = e.client ? e.client.get('auth') : null;
  if (clientAuth && clientAuth.collection().name !== '_superusers') {
    const collection = clientAuth.collection().name;
    if (collection !== 'admin_accounts' && collection !== 'participant_accounts') return;
    try {
      const currentAuth = $app.findRecordById(collection, clientAuth.id);
      if (currentAuth.get('status') !== 'active') return;
      if (collection === 'admin_accounts') {
        const org = $app.findRecordById('organizations', currentAuth.get('organization_id'));
        if (org.get('status') !== 'active') return;
      }
    } catch (_) { return; }
  }
  if (!e.message) {
    e.next();
    return;
  }
  const pairingPrefix = 'cc.participant.pairing.';
  const topic = String(e.message.name || '').split('?')[0];
  if (topic.indexOf(pairingPrefix) !== 0) {
    e.next();
    return;
  }
  // Realtime 连接先建立、后通过 subscribe 请求绑定 auth；e.auth 仍是最初连接请求的快照。
  // 发送时必须读取 client 当前保存的 auth record，才能正确覆盖多标签页/多设备连接。
  const auth = e.client ? e.client.get('auth') : null;
  const participantId = topic.slice(pairingPrefix.length);
  let current = null;
  if (auth && auth.collection().name === 'participant_accounts') {
    try { current = $app.findRecordById('participant_accounts', auth.id); } catch (_) { current = null; }
  }
  if (
    !auth || !current ||
    auth.collection().name !== 'participant_accounts' ||
    current.get('status') !== 'active' ||
    auth.id !== participantId
  ) {
    return;
  }
  let payload = null;
  let encoded = e.message.data || '';
  // JSVM 将 subscriptions.Message.data 暴露为 []byte；冻结 payload 仅含 ASCII 字段。
  if (Array.isArray(encoded)) {
    let decoded = '';
    for (const byte of encoded) decoded += String.fromCharCode(byte);
    encoded = decoded;
  }
  try {
    payload = JSON.parse(String(encoded));
  } catch (_) {
    return;
  }
  if (
    !payload ||
    payload.contract_version !== '2026-08-28.t0-v1' ||
    typeof payload.activity_id !== 'string' ||
    typeof payload.changed_at !== 'string'
  ) {
    return;
  }
  e.message.data = JSON.stringify({
    contract_version: '2026-08-28.t0-v1',
    activity_id: payload.activity_id,
    changed_at: payload.changed_at,
  });
  e.next();
});
