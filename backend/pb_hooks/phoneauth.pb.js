// phoneauth.pb.js — T1 参与者手机号验证码登录/注册、存量绑定与换绑。
//
// 内部契约：frontend/src/shared/api/accountEvent.ts（2026-08-28.t0-v1）。
// 外部 provider：阿里云号码认证服务 Dypnsapi/2017-05-25，使用
// SendSmsVerifyCode + CheckSmsVerifyCode；签名采用 ACS3-HMAC-SHA256。
//
// 安全边界：
// - 只支持 +86 大陆手机号；完整号码与验证码不写日志/审计/challenge；
// - 精确查找使用 HMAC-SHA256(CC_PHONE_HASH_KEY, phone_e164)；
// - challenge 持久化且在账号事务内一次消费，并发重试不能双消费；
// - request-code 按手机号、IP、设备会话三轴限流，响应不区分账号是否存在；
// - mock provider 必须显式启用，且 CC_ENVIRONMENT=production 时拒绝启动 mock 流程。
//
// PocketBase 0.28.4 JSVM hooks 文件顶层作用域不会暴露给请求 handler，故四个动作
// 合并到同一个动态路由 handler，共享函数全部位于该闭包内。

routerAdd('POST', '/api/cc/auth/participant/{phoneAction}', (e) => {
  try {
    const CONTRACT_VERSION = '2026-08-28.t0-v1';
    const PRIVACY_NOTICE_VERSION = $os.getenv('CC_PARTICIPANT_PRIVACY_NOTICE_VERSION') || '2026-08-28.v1';
    const CODE_EXPIRES_SEC = 300;
    const CODE_RETRY_SEC = 60;
    const PHONE_MAX = 3;
    const PHONE_WINDOW_SEC = 600;
    const IP_MAX = Number($os.getenv('CC_PHONE_CODE_IP_MAX') || '20');
    const IP_WINDOW_SEC = 3600;
    const DEVICE_MAX = 5;
    const DEVICE_WINDOW_SEC = 600;
    const VERIFY_MAX_ATTEMPTS = 5;

    const ccError = (status, code, message) => {
      throw { __ccError: true, status: status, code: code, message: message };
    };
    const ccProviderError = (code, requestId) => {
      throw { __ccProviderError: true, code: code || '', requestId: requestId || '' };
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
    const ccOne = (app, collection, filter, params) => {
      try {
        return app.findFirstRecordByFilter(collection, filter, params || {});
      } catch (err) {
        if (ccIsNoRows(err)) return null;
        throw err;
      }
    };
    const ccNow = () => new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
    const ccFuture = (seconds) =>
      new Date(Date.now() + seconds * 1000).toISOString().replace('T', ' ').slice(0, 23) + 'Z';
    const ccUniqueErr = (err) =>
      !!err && typeof err.message === 'string' && /unique/i.test(err.message);

    const writeAudit = (app, entry) => {
      const collection = app.findCollectionByNameOrId('audit_logs');
      const record = new Record(collection);
      record.set('actor_id', entry.actorId);
      record.set('actor_role', entry.actorRole);
      record.set('organization_id', '');
      record.set('action', entry.action);
      record.set('target_type', 'participant_account');
      record.set('target_id', entry.targetId);
      record.set('result', entry.result);
      record.set('reason', '');
      record.set('metadata', entry.metadata || null);
      app.save(record);
      return record;
    };

    const requireParticipant = () => {
      const auth = e.auth;
      if (!auth) ccError(401, 'unauthorized', '请先登录');
      if (auth.collection().name !== 'participant_accounts') {
        ccError(403, 'forbidden', '需要参与者身份');
      }
      if (auth.get('status') !== 'active') ccError(403, 'account_disabled', '账号已停用');
      return auth;
    };

    const normalizePhone = (value) => {
      const compact = String(value == null ? '' : value).replace(/[\s-]/g, '');
      let local = compact;
      if (local.indexOf('+86') === 0) local = local.slice(3);
      else if (local.indexOf('0086') === 0) local = local.slice(4);
      if (!/^1[3-9][0-9]{9}$/.test(local)) {
        ccError(400, 'invalid_phone', '请输入有效的中国大陆手机号');
      }
      return { e164: '+86' + local, local: local };
    };
    const phoneHashKey = () => {
      const key = $os.getenv('CC_PHONE_HASH_KEY');
      if (!key || key.length < 32) {
        ccError(503, 'provider_unavailable', '手机号认证服务暂不可用，请稍后再试');
      }
      return key;
    };
    const phoneHash = (phone) => $security.hs256(phone.e164, phoneHashKey());
    const phoneMask = (phone) => '+86 ' + phone.local.slice(0, 3) + '****' + phone.local.slice(7);

    // 验证码请求限流（与 lib/ratelimit.pb.js 原子版同源）：状态存 cc_rate_counters 集合，
    // DB 事务「检查即预占」（安全审查 finding 2/7、CWE-362 修复）——$app.store() 无原子自增
    // 原语，原「先 get 检查、业务后再 set 写回」的非原子计数可被并发请求突破阈值。
    const ccRlKey = (key) => 'cc_phone_rl|' + key;
    const ccRateNow = () => Math.floor(Date.now() / 1000);
    const ccRateIsBusy = (err) => !!err && /busy|locked|snapshot/i.test(String((err && err.message) || err));
    const ccRateOne = (app, key) => {
      try { return app.findFirstRecordByFilter('cc_rate_counters', 'key = {:k}', { k: key }); }
      catch (err) { if (!!err && typeof err.message === 'string' && err.message.indexOf('no rows') >= 0) return null; throw err; }
    };
    // json 字段读取解码（PB 0.28 读 json 字段返回原始 JSON 字节数组/字符串，非 JS 数组）
    const ccRateSlots = (rec) => {
      const v = rec && rec.get('slots');
      if (v === null || v === undefined || v === '') return [];
      let parsed = null;
      if (typeof v === 'string') { try { parsed = JSON.parse(v); } catch (_) { /* fallthrough */ } }
      else if (Array.isArray(v)) {
        const first = v[0];
        if (typeof first === 'number' && first > 128) { parsed = v; } // 已是时间戳数组
        else if (typeof first === 'number' && v.length === 0) { parsed = []; }
        else if (typeof first === 'number') { // 原始 JSON 字节数组（0-255）还原为字符串再解析
          let s = '';
          for (const b of v) s += String.fromCharCode(b);
          try { parsed = JSON.parse(s); } catch (_) { /* fallthrough */ }
        }
      }
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((x) => typeof x === 'number');
    };
    // 多键原子「检查即预占」（all-or-none）：任一键已超限则整体拒绝且一个都不预占；
    // 全部未超限则同时为各键预占一格（保持原「同请求须三轴同时通过才放行、任一超限即整体拒绝」语义）。
    const tryReserveMany = (keys) => {
      const now = ccRateNow();
      let allowed = false;
      let attempts = 0;
      for (;;) {
        try {
          $app.runInTransaction((txApp) => {
            const rows = keys.map(({ key }) => ccRateOne(txApp, ccRlKey(key)));
            // rows 与 keys 按索引对齐：逐键应用各自 window 过滤
            const keptAll = rows.map((rec, i) =>
              ccRateSlots(rec).filter((ts) => ts > now - keys[i].window),
            );
            for (let i = 0; i < keys.length; i++) {
              if (keptAll[i].length >= keys[i].max) { allowed = false; return; }
            }
            for (let i = 0; i < keys.length; i++) {
              const col = txApp.findCollectionByNameOrId('cc_rate_counters');
              const slots = keptAll[i];
              slots.push(now);
              if (rows[i]) {
                rows[i].set('slots', slots);
                txApp.save(rows[i]);
              } else {
                const created = new Record(col);
                created.set('key', ccRlKey(keys[i].key));
                created.set('slots', slots);
                txApp.save(created);
              }
            }
            allowed = true;
          });
          break;
        } catch (err) {
          if (ccRateIsBusy(err) && attempts < 2) { attempts++; continue; }
          if (ccRateIsBusy(err)) { allowed = false; break; } // fail-closed：拒绝而非放行
          throw err;
        }
      }
      return allowed;
    };
    const enforceRequestRate = (hash) => {
      const ipHash = $security.sha256(String(e.realIP() || 'unknown'));
      const rawDevice = String(e.request.header.get('X-CC-Device-Session') || '');
      const device = /^[A-Za-z0-9._-]{8,128}$/.test(rawDevice)
        ? $security.sha256(rawDevice)
        : ipHash;
      const keys = [
        { key: 'phone|' + hash, max: PHONE_MAX, window: PHONE_WINDOW_SEC },
        { key: 'ip|' + ipHash, max: IP_MAX, window: IP_WINDOW_SEC },
        { key: 'device|' + device, max: DEVICE_MAX, window: DEVICE_WINDOW_SEC },
      ];
      // 原子 all-or-none 预占：任一超限即整体拒绝（不预占任何键）
      if (!tryReserveMany(keys)) {
        ccError(429, 'code_throttled', '验证码请求过于频繁，请稍后再试');
      }
    };

    const providerName = () => {
      const provider = ($os.getenv('CC_SMS_PROVIDER') || 'aliyun').toLowerCase();
      if (provider !== 'aliyun' && provider !== 'mock') {
        ccError(503, 'provider_unavailable', '手机号认证服务暂不可用，请稍后再试');
      }
      if (provider === 'mock' && ($os.getenv('CC_ENVIRONMENT') || '').toLowerCase() === 'production') {
        ccError(503, 'provider_unavailable', '手机号认证服务暂不可用，请稍后再试');
      }
      return provider;
    };

    const rfc3986 = (value) =>
      encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
        '%' + char.charCodeAt(0).toString(16).toUpperCase(),
      );
    const queryString = (params) =>
      Object.keys(params)
        .sort()
        .map((key) => rfc3986(key) + '=' + rfc3986(params[key]))
        .join('&');

    const aliyunCall = (action, params) => {
      const accessKeyId = $os.getenv('ALIBABA_CLOUD_ACCESS_KEY_ID');
      const accessKeySecret = $os.getenv('ALIBABA_CLOUD_ACCESS_KEY_SECRET');
      if (!accessKeyId || !accessKeySecret) ccProviderError('CONFIG_MISSING', '');

      const host = 'dypnsapi.aliyuncs.com';
      const nonce = $security.randomStringWithAlphabet(
        32,
        'abcdefghijklmnopqrstuvwxyz0123456789',
      );
      const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const payloadHash = $security.sha256('');
      const headers = {
        host: host,
        'x-acs-action': action,
        'x-acs-content-sha256': payloadHash,
        'x-acs-date': date,
        'x-acs-signature-nonce': nonce,
        'x-acs-version': '2017-05-25',
      };
      const securityToken = $os.getenv('ALIBABA_CLOUD_SECURITY_TOKEN');
      if (securityToken) headers['x-acs-security-token'] = securityToken;
      const signedHeaders = Object.keys(headers).sort().join(';');
      const canonicalHeaders = Object.keys(headers)
        .sort()
        .map((key) => key.toLowerCase() + ':' + String(headers[key]).trim() + '\n')
        .join('');
      const query = queryString(params);
      const canonicalRequest =
        'POST\n/\n' +
        query +
        '\n' +
        canonicalHeaders +
        '\n' +
        signedHeaders +
        '\n' +
        payloadHash;
      const stringToSign = 'ACS3-HMAC-SHA256\n' + $security.sha256(canonicalRequest);
      const signature = $security.hs256(stringToSign, accessKeySecret);
      const authorization =
        'ACS3-HMAC-SHA256 Credential=' +
        accessKeyId +
        ',SignedHeaders=' +
        signedHeaders +
        ',Signature=' +
        signature;
      const requestHeaders = {};
      for (const key of Object.keys(headers)) requestHeaders[key] = headers[key];
      requestHeaders.Authorization = authorization;
      requestHeaders.Accept = 'application/json';

      try {
        const response = $http.send({
          method: 'POST',
          url: 'https://' + host + '/?' + query,
          headers: requestHeaders,
          timeout: 10,
        });
        const json = response.json || {};
        if (response.statusCode < 200 || response.statusCode >= 300 || json.Code !== 'OK' || json.Success !== true) {
          ccProviderError(json.Code || 'HTTP_' + response.statusCode, json.RequestId || '');
        }
        return json;
      } catch (err) {
        if (err && err.__ccProviderError) throw err;
        ccProviderError('NETWORK_ERROR', '');
      }
    };

    const sendCode = (provider, phone, challengeId) => {
      if (provider === 'mock') {
        const mockCode = $os.getenv('CC_SMS_MOCK_CODE');
        if (!/^[0-9]{4,8}$/.test(mockCode || '')) ccProviderError('MOCK_NOT_CONFIGURED', '');
        if ($os.getenv('CC_SMS_MOCK_FAIL_PHONE') === phone.local) {
          ccProviderError('MOCK_PROVIDER_UNAVAILABLE', 'mock-' + challengeId);
        }
        return { requestId: 'mock-' + challengeId };
      }
      const signName = $os.getenv('CC_SMS_SIGN_NAME');
      const templateCode = $os.getenv('CC_SMS_TEMPLATE_CODE');
      if (!signName || !templateCode) ccProviderError('CONFIG_MISSING', '');
      const params = {
        AutoRetry: '1',
        CodeLength: '6',
        CodeType: '1',
        CountryCode: '86',
        DuplicatePolicy: '1',
        Interval: String(CODE_RETRY_SEC),
        OutId: challengeId,
        PhoneNumber: phone.local,
        ReturnVerifyCode: 'false',
        SignName: signName,
        TemplateCode: templateCode,
        TemplateParam: JSON.stringify({ code: '##code##', min: String(CODE_EXPIRES_SEC / 60) }),
        ValidTime: String(CODE_EXPIRES_SEC),
      };
      const scheme = $os.getenv('CC_SMS_SCHEME_NAME');
      if (scheme) params.SchemeName = scheme;
      const response = aliyunCall('SendSmsVerifyCode', params);
      return {
        requestId:
          (response.Model && response.Model.RequestId) || response.RequestId || '',
      };
    };

    const checkCode = (provider, phone, challengeId, code) => {
      if (!/^[0-9]{4,8}$/.test(String(code || ''))) return false;
      if (provider === 'mock') return String(code) === $os.getenv('CC_SMS_MOCK_CODE');
      const params = {
        CaseAuthPolicy: '2',
        CountryCode: '86',
        OutId: challengeId,
        PhoneNumber: phone.local,
        VerifyCode: String(code),
      };
      const scheme = $os.getenv('CC_SMS_SCHEME_NAME');
      if (scheme) params.SchemeName = scheme;
      const response = aliyunCall('CheckSmsVerifyCode', params);
      return !!response.Model && response.Model.VerifyResult === 'PASS';
    };

    const publicPhoneRecord = (record) => ({
      id: record.id,
      collectionId: record.collection().id,
      collectionName: record.collection().name,
      created: String(record.get('created') || ''),
      updated: String(record.get('updated') || ''),
      status: record.get('status'),
      phone_masked: phoneMask(normalizePhone(record.get('phone_e164'))),
      phone_verified_at: String(record.get('phone_verified_at') || ''),
      phone_binding_source: record.get('phone_binding_source') || undefined,
      phone_migration_status: record.get('phone_migration_status') || 'legacy_unbound',
    });

    const challengeStateError = (challenge) => {
      if (!challenge) ccError(400, 'code_invalid', '验证码无效，请重新获取');
      const status = challenge.get('status');
      if (status === 'consumed') ccError(409, 'challenge_consumed', '验证码已使用，请重新获取');
      if (status !== 'sent') ccError(400, 'code_invalid', '验证码无效，请重新获取');
      if (new Date(String(challenge.get('expires_at'))).getTime() <= Date.now()) {
        ccError(400, 'code_expired', '验证码已过期，请重新获取');
      }
      if (Number(challenge.get('attempt_count') || 0) >= VERIFY_MAX_ATTEMPTS) {
        ccError(400, 'code_invalid', '验证码无效，请重新获取');
      }
    };

    const loadChallenge = (app, input) => {
      const challenge = ccById(app, 'participant_phone_challenges', String(input.challengeId || ''));
      challengeStateError(challenge);
      if (
        challenge.get('phone_lookup_hash') !== input.hash ||
        challenge.get('purpose') !== input.purpose ||
        String(challenge.get('participant_id') || '') !== String(input.participantId || '') ||
        (input.changeRole && challenge.get('change_role') !== input.changeRole)
      ) {
        ccError(400, 'code_invalid', '验证码无效，请重新获取');
      }
      return challenge;
    };

    const recordInvalidAttempt = (challenge) => {
      challenge.set('attempt_count', Number(challenge.get('attempt_count') || 0) + 1);
      if (Number(challenge.get('attempt_count')) >= VERIFY_MAX_ATTEMPTS) {
        challenge.set('status', 'failed');
      }
      $app.save(challenge);
    };

    const verifyChallengeProvider = (challenge, phone, code) => {
      let passed = false;
      try {
        passed = checkCode(challenge.get('provider'), phone, challenge.id, code);
      } catch (err) {
        if (err && err.__ccProviderError) {
          $app.logger().error(
            'Phone verification provider unavailable',
            'provider_code',
            err.code,
            'request_id',
            err.requestId,
          );
          ccError(503, 'provider_unavailable', '验证码服务暂不可用，请稍后再试');
        }
        throw err;
      }
      if (!passed) {
        recordInvalidAttempt(challenge);
        ccError(400, 'code_invalid', '验证码不正确，请重试');
      }
    };

    const consumeChallenge = (app, challenge) => {
      challenge.set('status', 'consumed');
      challenge.set('consumed_at', ccNow());
      app.save(challenge);
    };

    const action = String(e.request.pathValue('phoneAction') || '');
    const body = e.requestInfo().body || {};

    // -----------------------------------------------------------------------
    // request-code
    // -----------------------------------------------------------------------
    if (action === 'request-code') {
      const purpose = String(body.purpose || '');
      if (['login_or_register', 'bind_phone', 'change_phone'].indexOf(purpose) < 0) {
        ccError(400, 'code_invalid', '验证码用途无效');
      }
      const participant = purpose === 'login_or_register' ? null : requireParticipant();
      const phone = normalizePhone(body.phone);
      const hash = phoneHash(phone);
      if (purpose === 'login_or_register') {
        if (String(body.privacy_notice_version || '') !== PRIVACY_NOTICE_VERSION) {
          ccError(400, 'privacy_notice_required', '请阅读并同意隐私说明后继续');
        }
      }
      if (purpose === 'bind_phone' && participant.get('phone_migration_status') === 'phone_bound') {
        ccError(409, 'phone_conflict', '当前账号已绑定手机号，请使用换绑流程');
      }
      let changeRole = '';
      if (purpose === 'change_phone') {
        const currentHash = String(participant.get('phone_lookup_hash') || '');
        if (!currentHash) ccError(409, 'phone_conflict', '当前账号尚未绑定手机号');
        changeRole = currentHash === hash ? 'old' : 'new';
      }

      enforceRequestRate(hash);
      const provider = providerName();
      const collection = $app.findCollectionByNameOrId('participant_phone_challenges');
      const challenge = new Record(collection);
      challenge.set('phone_lookup_hash', hash);
      challenge.set('purpose', purpose);
      challenge.set('change_role', changeRole);
      challenge.set('participant_id', participant ? participant.id : '');
      challenge.set('status', 'pending');
      challenge.set('provider', provider);
      challenge.set('privacy_notice_version', String(body.privacy_notice_version || ''));
      challenge.set('provider_request_id', '');
      challenge.set('attempt_count', 0);
      challenge.set('expires_at', ccFuture(CODE_EXPIRES_SEC));
      $app.save(challenge);

      try {
        const sent = sendCode(provider, phone, challenge.id);
        challenge.set('status', 'sent');
        challenge.set('sent_at', ccNow());
        challenge.set('provider_request_id', sent.requestId || '');
        $app.save(challenge);
      } catch (err) {
        challenge.set('status', 'failed');
        $app.save(challenge);
        if (err && err.__ccProviderError) {
          $app.logger().error(
            'Phone code provider unavailable',
            'provider_code',
            err.code,
            'request_id',
            err.requestId,
          );
          ccError(503, 'provider_unavailable', '验证码服务暂不可用，请稍后再试');
        }
        throw err;
      }

      return e.json(200, {
        contract_version: CONTRACT_VERSION,
        accepted: true,
        challenge_id: challenge.id,
        expires_in_seconds: CODE_EXPIRES_SEC,
        retry_after_seconds: CODE_RETRY_SEC,
      });
    }

    // -----------------------------------------------------------------------
    // verify-code — 匿名手机号登录/注册
    // -----------------------------------------------------------------------
    if (action === 'verify-code') {
      const phone = normalizePhone(body.phone);
      const hash = phoneHash(phone);
      const challenge = loadChallenge($app, {
        challengeId: body.challenge_id,
        hash: hash,
        purpose: 'login_or_register',
        participantId: '',
      });
      verifyChallengeProvider(challenge, phone, body.code);

      let participant = null;
      let created = false;
      let disabled = false;
      $app.runInTransaction((txApp) => {
        const txChallenge = loadChallenge(txApp, {
          challengeId: body.challenge_id,
          hash: hash,
          purpose: 'login_or_register',
          participantId: '',
        });
        participant = ccOne(
          txApp,
          'participant_accounts',
          'phone_lookup_hash = {:hash}',
          { hash: hash },
        );
        if (!participant) {
          let savedNewParticipant = false;
          const collection = txApp.findCollectionByNameOrId('participant_accounts');
          participant = new Record(collection);
          participant.set(
            'username',
            'p_' + $security.randomStringWithAlphabet(18, 'abcdefghijklmnopqrstuvwxyz0123456789'),
          );
          participant.set('password', $security.randomString(32));
          participant.set('status', 'active');
          participant.set('phone_e164', phone.e164);
          participant.set('phone_lookup_hash', hash);
          participant.set('phone_verified_at', ccNow());
          participant.set('phone_binding_source', 'sms_signup');
          participant.set('phone_migration_status', 'phone_bound');
          try {
            txApp.save(participant);
            savedNewParticipant = true;
          } catch (err) {
            if (!ccUniqueErr(err)) throw err;
            participant = ccOne(
              txApp,
              'participant_accounts',
              'phone_lookup_hash = {:hash}',
              { hash: hash },
            );
            if (!participant) throw err;
          }
          if (savedNewParticipant) {
            created = true;
            writeAudit(txApp, {
              actorId: participant.id,
              actorRole: 'participant',
              action: 'phone.signup',
              targetId: participant.id,
              result: 'success',
              metadata: {
                phone_masked: phoneMask(phone),
                phone_lookup_hash: hash,
                privacy_notice_version: txChallenge.get('privacy_notice_version'),
              },
            });
          }
        }
        disabled = participant.get('status') !== 'active';
        consumeChallenge(txApp, txChallenge);
      });
      if (disabled) ccError(403, 'account_disabled', '账号已停用');
      return e.json(200, {
        contract_version: CONTRACT_VERSION,
        token: participant.newAuthToken(),
        record: publicPhoneRecord(participant),
        created: created,
      });
    }

    // -----------------------------------------------------------------------
    // bind-phone — 存量用户名账号绑定，保留 participant_id
    // -----------------------------------------------------------------------
    if (action === 'bind-phone') {
      const auth = requireParticipant();
      const phone = normalizePhone(body.phone);
      const hash = phoneHash(phone);
      const challenge = loadChallenge($app, {
        challengeId: body.challenge_id,
        hash: hash,
        purpose: 'bind_phone',
        participantId: auth.id,
      });
      verifyChallengeProvider(challenge, phone, body.code);

      let participant = null;
      let conflict = false;
      $app.runInTransaction((txApp) => {
        participant = ccById(txApp, 'participant_accounts', auth.id);
        const txChallenge = loadChallenge(txApp, {
          challengeId: body.challenge_id,
          hash: hash,
          purpose: 'bind_phone',
          participantId: auth.id,
        });
        const owner = ccOne(
          txApp,
          'participant_accounts',
          'phone_lookup_hash = {:hash}',
          { hash: hash },
        );
        if (owner && owner.id !== participant.id) {
          conflict = true;
          participant.set('phone_migration_status', 'merge_required');
          txApp.save(participant);
          writeAudit(txApp, {
            actorId: participant.id,
            actorRole: 'participant',
            action: 'phone.bind_conflict',
            targetId: participant.id,
            result: 'failure',
            metadata: { phone_masked: phoneMask(phone), phone_lookup_hash: hash },
          });
        } else if (
          participant.get('phone_lookup_hash') &&
          participant.get('phone_lookup_hash') !== hash
        ) {
          conflict = true;
        } else {
          participant.set('phone_e164', phone.e164);
          participant.set('phone_lookup_hash', hash);
          participant.set('phone_verified_at', ccNow());
          participant.set('phone_binding_source', 'legacy_bind');
          participant.set('phone_migration_status', 'phone_bound');
          txApp.save(participant);
          writeAudit(txApp, {
            actorId: participant.id,
            actorRole: 'participant',
            action: 'phone.bind',
            targetId: participant.id,
            result: 'success',
            metadata: { phone_masked: phoneMask(phone), phone_lookup_hash: hash },
          });
        }
        consumeChallenge(txApp, txChallenge);
      });
      if (conflict) ccError(409, 'phone_conflict', '该手机号无法自动绑定，请联系人工支持');
      return e.json(200, {
        contract_version: CONTRACT_VERSION,
        participant_id: participant.id,
        phone_masked: phoneMask(phone),
        phone_verified_at: String(participant.get('phone_verified_at')),
        phone_migration_status: 'phone_bound',
      });
    }

    // -----------------------------------------------------------------------
    // change-phone — 旧号 + 新号双验证码原子换绑
    // -----------------------------------------------------------------------
    if (action === 'change-phone') {
      const auth = requireParticipant();
      if (body.verification_method !== 'old_phone') {
        ccError(409, 'support_required', '无法验证旧手机号时，请联系人工支持处理');
      }
      const participantBefore = ccById($app, 'participant_accounts', auth.id);
      const oldPhone = normalizePhone(participantBefore.get('phone_e164'));
      const oldHash = phoneHash(oldPhone);
      const newPhone = normalizePhone(body.phone);
      const newHash = phoneHash(newPhone);
      if (newHash === oldHash) ccError(409, 'phone_conflict', '新手机号不能与当前手机号相同');

      const newChallenge = loadChallenge($app, {
        challengeId: body.challenge_id,
        hash: newHash,
        purpose: 'change_phone',
        participantId: auth.id,
        changeRole: 'new',
      });
      const oldChallenge = loadChallenge($app, {
        challengeId: body.old_phone_challenge_id,
        hash: oldHash,
        purpose: 'change_phone',
        participantId: auth.id,
        changeRole: 'old',
      });
      verifyChallengeProvider(newChallenge, newPhone, body.code);
      verifyChallengeProvider(oldChallenge, oldPhone, body.old_phone_code);

      let participant = null;
      let conflict = false;
      $app.runInTransaction((txApp) => {
        participant = ccById(txApp, 'participant_accounts', auth.id);
        const txNew = loadChallenge(txApp, {
          challengeId: body.challenge_id,
          hash: newHash,
          purpose: 'change_phone',
          participantId: auth.id,
          changeRole: 'new',
        });
        const txOld = loadChallenge(txApp, {
          challengeId: body.old_phone_challenge_id,
          hash: oldHash,
          purpose: 'change_phone',
          participantId: auth.id,
          changeRole: 'old',
        });
        if (participant.get('phone_lookup_hash') !== oldHash) {
          conflict = true;
        } else {
          const owner = ccOne(
            txApp,
            'participant_accounts',
            'phone_lookup_hash = {:hash}',
            { hash: newHash },
          );
          if (owner && owner.id !== participant.id) {
            conflict = true;
          } else {
            participant.set('phone_e164', newPhone.e164);
            participant.set('phone_lookup_hash', newHash);
            participant.set('phone_verified_at', ccNow());
            participant.set('phone_migration_status', 'phone_bound');
            txApp.save(participant);
            writeAudit(txApp, {
              actorId: participant.id,
              actorRole: 'participant',
              action: 'phone.change',
              targetId: participant.id,
              result: 'success',
              metadata: {
                old_phone_masked: phoneMask(oldPhone),
                old_phone_lookup_hash: oldHash,
                new_phone_masked: phoneMask(newPhone),
                new_phone_lookup_hash: newHash,
              },
            });
          }
        }
        consumeChallenge(txApp, txNew);
        consumeChallenge(txApp, txOld);
      });
      if (conflict) ccError(409, 'phone_conflict', '手机号状态已变化，请重新开始换绑流程');
      return e.json(200, {
        contract_version: CONTRACT_VERSION,
        participant_id: participant.id,
        phone_masked: phoneMask(newPhone),
        phone_verified_at: String(participant.get('phone_verified_at')),
        phone_migration_status: 'phone_bound',
      });
    }

    ccError(404, 'not_found', '接口不存在');
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
