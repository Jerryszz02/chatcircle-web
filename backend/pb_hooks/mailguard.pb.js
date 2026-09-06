// mailguard.pb.js — 管理员邮件类内置端点限流与找回门控（2026-08 后端改版，AC-24）
//
// 背景：admin_accounts 邮箱化后（迁移 1785889440），邮箱验证 / OTP 验证码 / 密码重置
// 三个 PB 内置请求端点会真实发信，必须防刷（SMTP 凭据滥用、邮件轰炸、账号枚举）。
// 本文件不重写认证逻辑，只对内置端点加限流与门控（technical-design §5.4「管理员邮箱认证」）。
//
// 钩子与语义（0.28.4，同 authguard.pb.js 实测模式）：
// - onRecordRequestVerificationRequest / onRecordRequestOTPRequest /
//   onRecordRequestPasswordResetRequest 在发信处理前触发，事件内 e.record 为目标账号
//   （邮箱不存在时不发信；验证/找回返回 204，OTP 返回 200 + 随机 otpId）；
// - e.request 为 undefined，可用 e.realIP() / e.requestInfo() / e.noContent / e.collection / e.record；
// - 不调用 e.next() 即静默取消后续处理。
//
// ⚠️ 防账号枚举设计（review 修订）：这三个钩子只在邮箱**存在**时触发。若超限响应 429，
// 探测者可用「第 N 次请求是否 429」区分已注册邮箱（429）与不存在邮箱（正常响应），
// 形成账号枚举 oracle。因此本文件的限流一律**静默拦截**：验证/找回返回 204；OTP 返回 200 + 随机 otpId，
// 超限时不调 e.next()（不发信）并写审计 auth.mail.throttled，响应与正常/不存在完全一致。
//
// 规则（窗口与数值见 security-privacy §9）：
// - per-email 频率限制：每端点每邮箱 1 小时滑窗内 3 次请求，超限静默拦截 + 审计；
// - per-IP 频率限制：三端点共享一桶，1 小时滑窗内 20 次请求，超限静默拦截 + 审计；
// - 找回门控：record.verified = false 时不调 e.next()、静默拦截（不发邮件、不放行），
//   写审计 auth.password_reset.suppressed（仅已验证邮箱可找回密码）；
// - OTP 认证成功即证明邮箱所有权：认证成功钩子内将 verified=false 的账号置 true 落库
//   （PB 原生若已置位则本次保存为无操作）。
//
// 状态存 $app.store()（Go 侧共享 KV），键前缀 cc_rl|；
// 限流函数与 lib/ratelimit.pb.js 契约同源（JSVM 无跨文件共享，按约定内联，勿手工改副本）。
// ⚠️ 本文件为「handler 自包含」模式（同 auth.pb.js 头注释约束）。

// ---------------------------------------------------------------------------
// 三个请求钩子同构：per-email（按用途分桶）+ per-IP（三端点共桶）限流，
// 超限返回该端点的正常响应形状 + 审计（防枚举，见文件头）。JSVM 各钩子作用域隔离，
// 函数在每个钩子内就地展开（勿提取跨钩子共享）。
// ---------------------------------------------------------------------------

onRecordRequestVerificationRequest((e) => {
  const ccRlKey = (key) => 'cc_rl|' + key;
  const checkRateLimit = (key, max, windowSec) => {
    const now = Math.floor(Date.now() / 1000);
    const kept = ($app.store().get(ccRlKey(key)) || []).filter((ts) => ts > now - windowSec);
    return kept.length < max;
  };
  const recordRateLimitAttempt = (key, windowSec) => {
    const now = Math.floor(Date.now() / 1000);
    const k = ccRlKey(key);
    const kept = ($app.store().get(k) || []).filter((ts) => ts > now - windowSec);
    kept.push(now);
    $app.store().set(k, kept);
  };
  // 写一条审计日志（与 lib/audit.pb.js 同源；事务内传 txApp，同事务提交）
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
  const CC_MAIL_EMAIL_MAX = 3; // per-email 每端点 3 次/小时
  const CC_MAIL_IP_MAX = 20; // per-IP 三端点共桶 20 次/小时
  const CC_MAIL_WINDOW_SEC = 3600;
  // 静默拦截：恒 204（与正常/邮箱不存在响应一致，防账号枚举），不发信 + 审计
  const ccSilentDeny = (reason) => {
    const rec = e.record;
    writeAudit($app, {
      actorId: rec ? rec.id : '', actorRole: 'admin',
      organizationId: rec ? (rec.get('organization_id') || '') : '',
      action: 'auth.mail.throttled', targetType: 'admin_account',
      targetId: rec ? rec.id : '', result: 'failure', reason: reason,
    });
    e.noContent(204);
  };

  const ip = e.realIP();
  const body = e.requestInfo().body || {};
  const email = String(body.email == null ? '' : body.email).trim().toLowerCase().slice(0, 254);

  const ipKey = 'mailip|' + ip;
  if (!checkRateLimit(ipKey, CC_MAIL_IP_MAX, CC_MAIL_WINDOW_SEC)) {
    return ccSilentDeny('验证邮件请求超 per-IP 限流（20 次/小时）');
  }
  const emailKey = 'mail|verify|' + email;
  if (email && !checkRateLimit(emailKey, CC_MAIL_EMAIL_MAX, CC_MAIL_WINDOW_SEC)) {
    return ccSilentDeny('验证邮件请求超 per-email 限流（3 次/小时）');
  }
  recordRateLimitAttempt(ipKey, CC_MAIL_WINDOW_SEC);
  if (email) recordRateLimitAttempt(emailKey, CC_MAIL_WINDOW_SEC);
  return e.next();
}, 'admin_accounts');

onRecordRequestOTPRequest((e) => {
  const ccRlKey = (key) => 'cc_rl|' + key;
  const checkRateLimit = (key, max, windowSec) => {
    const now = Math.floor(Date.now() / 1000);
    const kept = ($app.store().get(ccRlKey(key)) || []).filter((ts) => ts > now - windowSec);
    return kept.length < max;
  };
  const recordRateLimitAttempt = (key, windowSec) => {
    const now = Math.floor(Date.now() / 1000);
    const k = ccRlKey(key);
    const kept = ($app.store().get(k) || []).filter((ts) => ts > now - windowSec);
    kept.push(now);
    $app.store().set(k, kept);
  };
  // 写一条审计日志（与 lib/audit.pb.js 同源；事务内传 txApp，同事务提交）
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
  const CC_MAIL_EMAIL_MAX = 3;
  const CC_MAIL_IP_MAX = 20;
  const CC_MAIL_WINDOW_SEC = 3600;
  const ccSilentDeny = (reason) => {
    const rec = e.record;
    writeAudit($app, {
      actorId: rec ? rec.id : '', actorRole: 'admin',
      organizationId: rec ? (rec.get('organization_id') || '') : '',
      action: 'auth.mail.throttled', targetType: 'admin_account',
      targetId: rec ? rec.id : '', result: 'failure', reason: reason,
    });
    // 正常/未知邮箱均返回小写字母数字组成的 15 位 otpId；超限不创建有效验证码。
    e.json(200, { otpId: $security.randomStringWithAlphabet(15, 'abcdefghijklmnopqrstuvwxyz0123456789') });
  };

  const ip = e.realIP();
  const body = e.requestInfo().body || {};
  const email = String(body.email == null ? '' : body.email).trim().toLowerCase().slice(0, 254);

  const ipKey = 'mailip|' + ip;
  if (!checkRateLimit(ipKey, CC_MAIL_IP_MAX, CC_MAIL_WINDOW_SEC)) {
    return ccSilentDeny('OTP 请求超 per-IP 限流（20 次/小时）');
  }
  const emailKey = 'mail|otp|' + email;
  if (email && !checkRateLimit(emailKey, CC_MAIL_EMAIL_MAX, CC_MAIL_WINDOW_SEC)) {
    return ccSilentDeny('OTP 请求超 per-email 限流（3 次/小时）');
  }
  recordRateLimitAttempt(ipKey, CC_MAIL_WINDOW_SEC);
  if (email) recordRateLimitAttempt(emailKey, CC_MAIL_WINDOW_SEC);
  return e.next();
}, 'admin_accounts');

// ---------------------------------------------------------------------------
// 找回密码：限流（同上静默口径）+「仅已验证邮箱可找回」门控（AC-24）
// ---------------------------------------------------------------------------
onRecordRequestPasswordResetRequest((e) => {
  const ccRlKey = (key) => 'cc_rl|' + key;
  const checkRateLimit = (key, max, windowSec) => {
    const now = Math.floor(Date.now() / 1000);
    const kept = ($app.store().get(ccRlKey(key)) || []).filter((ts) => ts > now - windowSec);
    return kept.length < max;
  };
  const recordRateLimitAttempt = (key, windowSec) => {
    const now = Math.floor(Date.now() / 1000);
    const k = ccRlKey(key);
    const kept = ($app.store().get(k) || []).filter((ts) => ts > now - windowSec);
    kept.push(now);
    $app.store().set(k, kept);
  };
  // 写一条审计日志（与 lib/audit.pb.js 同源；事务内传 txApp，同事务提交）
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
  const CC_MAIL_EMAIL_MAX = 3;
  const CC_MAIL_IP_MAX = 20;
  const CC_MAIL_WINDOW_SEC = 3600;
  // 静默拦截：恒 204（与正常/邮箱不存在响应一致，防账号枚举），不发信 + 审计
  const ccSilentDeny = (action, reason) => {
    const rec = e.record;
    writeAudit($app, {
      actorId: rec ? rec.id : '', actorRole: 'admin',
      organizationId: rec ? (rec.get('organization_id') || '') : '',
      action: action, targetType: 'admin_account',
      targetId: rec ? rec.id : '', result: 'failure', reason: reason,
    });
    e.noContent(204);
  };

  const ip = e.realIP();
  const body = e.requestInfo().body || {};
  const email = String(body.email == null ? '' : body.email).trim().toLowerCase().slice(0, 254);

  const ipKey = 'mailip|' + ip;
  if (!checkRateLimit(ipKey, CC_MAIL_IP_MAX, CC_MAIL_WINDOW_SEC)) {
    return ccSilentDeny('auth.mail.throttled', '找回密码请求超 per-IP 限流（20 次/小时）');
  }
  const emailKey = 'mail|reset|' + email;
  if (email && !checkRateLimit(emailKey, CC_MAIL_EMAIL_MAX, CC_MAIL_WINDOW_SEC)) {
    return ccSilentDeny('auth.mail.throttled', '找回密码请求超 per-email 限流（3 次/小时）');
  }
  recordRateLimitAttempt(ipKey, CC_MAIL_WINDOW_SEC);
  if (email) recordRateLimitAttempt(emailKey, CC_MAIL_WINDOW_SEC);

  // 找回门控：未验证邮箱静默拦截——不放行发信，响应与正常一致（204），防账号枚举
  const record = e.record;
  if (record && !record.get('verified')) {
    return ccSilentDeny('auth.password_reset.suppressed', '邮箱未完成验证，找回密码请求被拦截');
  }
  return e.next();
}, 'admin_accounts');

// ---------------------------------------------------------------------------
// OTP 认证成功即证明邮箱所有权：verified=false 的账号置 true 落库（AC-24）
// （PB 原生若已置位，本次保存为无操作；0.28.4 实测以集成为准）
// ---------------------------------------------------------------------------
onRecordAuthWithOTPRequest((e) => {
  e.next();
  const record = e.record;
  if (record && !record.get('verified')) {
    record.set('verified', true);
    $app.save(record);
  }
}, 'admin_accounts');
