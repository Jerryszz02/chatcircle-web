# -*- coding: utf-8 -*-
"""suite_admin_email — 管理员邮箱认证（AC-24，2026-08 后端改版，PRD 外扩展）。

断言：
- 注册必填邮箱：缺 email / 非法格式 → 400 INVALID_EMAIL；成功注册 verified=false、
  email 落库小写归一（注册响应为匿名视角、emailVisibility=false 隐藏 email，经超管通道回读）；
- 邮箱大小写不敏感唯一：重复（大小写变体）→ 400 EMAIL_TAKEN；
- 邮箱+密码登录：内置 auth-with-password 以 email 作 identity 成功
  （⚠️ 内置认证 per-IP 预算：本套件仅此 1 次内置认证调用，见 suite_hardening 头注释）；
- 找回门控：未验证邮箱 request-password-reset → 204 静默拦截且审计有
  auth.password_reset.suppressed；超管置 verified=true 后再请求 → 204 且无新增
  suppressed 审计（测试环境无 SMTP，不断言真实投递）；
- 邮件类端点限流（mailguard.pb.js）：同 email 第 4 次 request-verification → 静默 204
  且审计 auth.mail.throttled（静默口径：429 只对已注册邮箱触发会形成枚举 oracle）；
- OTP 端点可用：request-otp → 200 且返回 otpId（无 SMTP 环境 PB 仍受理；验证码投递
  与 auth-with-otp 全链路属上线验收，不在 L3 覆盖——验证码 bcrypt 落库不可取回）；
- 直连改邮箱被 guards.pb.js 禁止（403）；换邮箱走 PB 内置 requestEmailChange 流程。
"""
import cc_fixture as fx
from cc_client import biz_code, call


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    rep.section('suite_admin_email：管理员邮箱认证（AC-24）')

    org = fx.create_org(base, st, '邮箱认证机构')

    def new_invite():
        s2, r2 = call(base, 'POST', '/api/cc/super/invites', {'organization_id': org}, st)
        assert s2 == 200, '生成邀请码失败：%s' % r2
        return r2['invite']['token']

    def suppressed_count():
        s2, r2 = call(base, 'GET',
                      "/api/collections/audit_logs/records?filter=(action='auth.password_reset.suppressed')",
                      token=st)
        assert s2 == 200, '读审计失败：%s' % r2
        return r2.get('totalItems')

    def throttled_count():
        s2, r2 = call(base, 'GET',
                      "/api/collections/audit_logs/records?filter=(action='auth.mail.throttled')",
                      token=st)
        assert s2 == 200, '读审计失败：%s' % r2
        return r2.get('totalItems')

    # ---------- 1. 注册邮箱校验（AC-24）----------
    s, r = call(base, 'POST', '/api/cc/auth/admin-register',
                {'invite_code': new_invite(), 'username': 'aem_admin_1', 'password': fx.PASSWORD})
    rep.check('AEM-01 缺 email → 400 INVALID_EMAIL',
              s == 400 and biz_code(r) == 'INVALID_EMAIL', r)
    s, r = call(base, 'POST', '/api/cc/auth/admin-register',
                {'invite_code': new_invite(), 'username': 'aem_admin_1', 'email': 'not-an-email',
                 'password': fx.PASSWORD})
    rep.check('AEM-02 非法 email 格式 → 400 INVALID_EMAIL',
              s == 400 and biz_code(r) == 'INVALID_EMAIL', r)

    s, r = call(base, 'POST', '/api/cc/auth/admin-register',
                {'invite_code': new_invite(), 'username': 'aem_admin_1',
                 'email': 'AemAdmin1@IT.CC.LOCAL', 'password': fx.PASSWORD})
    rep.check('AEM-03 带 email 注册成功（verified=false）',
              s == 200 and (r.get('record') or {}).get('verified') is False, r)
    s, rr = call(base, 'GET',
                 "/api/collections/admin_accounts/records?filter=(username='aem_admin_1')", token=st)
    stored = (rr.get('items') or [{}])[0]
    rep.check('AEM-04 email 落库小写归一（超管通道回读）',
              s == 200 and stored.get('email') == 'aemadmin1@it.cc.local'
              and stored.get('verified') is False, rr)
    rep.check('AEM-05 注册响应为匿名视角、不泄露 email 字段',
              'email' not in (r.get('record') or {}), r)

    s, r = call(base, 'POST', '/api/cc/auth/admin-register',
                {'invite_code': new_invite(), 'username': 'aem_admin_2',
                 'email': 'AEMADMIN1@it.cc.local', 'password': fx.PASSWORD})
    rep.check('AEM-06 重复 email（大小写变体）→ 400 EMAIL_TAKEN',
              s == 400 and biz_code(r) == 'EMAIL_TAKEN', r)

    # ---------- 2. 邮箱+密码登录（identityFields 含 email）----------
    # ⚠️ 本套件唯一一次内置 auth-with-password（per-IP 预算见 suite_hardening 头注释）
    s, r = call(base, 'POST', '/api/collections/admin_accounts/auth-with-password',
                {'identity': 'aemadmin1@it.cc.local', 'password': fx.PASSWORD})
    rep.check('AEM-07 邮箱作 identity 登录成功（identityFields 含 email）',
              s == 200 and bool(r.get('token')), r)

    # ---------- 3. 找回密码门控：仅已验证邮箱放行 ----------
    before = suppressed_count()
    s, r = call(base, 'POST', '/api/collections/admin_accounts/request-password-reset',
                {'email': 'aemadmin1@it.cc.local'})
    rep.check('AEM-08 未验证邮箱找回 → 204（静默、防账号枚举）', s == 204, r)
    rep.check('AEM-09 未验证找回被拦截并写审计 auth.password_reset.suppressed',
              suppressed_count() == before + 1, suppressed_count())

    # 超管直改 verified=true（模拟完成验证；改 email 之外的字段 guards 不拦超管）
    s, rr = call(base, 'PATCH', '/api/collections/admin_accounts/records/%s' % stored.get('id'),
                 {'verified': True}, st)
    assert s == 200 and rr.get('verified') is True, '超管置 verified 失败：%s' % rr
    s, r = call(base, 'POST', '/api/collections/admin_accounts/request-password-reset',
                {'email': 'aemadmin1@it.cc.local'})
    rep.check('AEM-10 已验证邮箱找回 → 204 放行（无 SMTP 不断言投递）', s == 204, r)
    rep.check('AEM-11 已验证找回不产生新的 suppressed 审计',
              suppressed_count() == before + 1, suppressed_count())

    # ---------- 4. 邮件类端点限流（per-email 3 次/小时，静默 204 防枚举）----------
    codes = []
    for _ in range(3):
        s, r = call(base, 'POST', '/api/collections/admin_accounts/request-verification',
                    {'email': 'aemadmin1@it.cc.local'})
        codes.append(s)
    rep.check('AEM-12 前 3 次 request-verification 受理（204，无 SMTP 不断言投递）',
              codes == [204] * 3, codes)
    t_before = throttled_count()
    s, r = call(base, 'POST', '/api/collections/admin_accounts/request-verification',
                {'email': 'aemadmin1@it.cc.local'})
    rep.check('AEM-13 第 4 次 → 仍 204（静默拦截，防「429 即已注册」枚举 oracle）'
              '且审计 auth.mail.throttled +1',
              s == 204 and throttled_count() == t_before + 1, r)

    # ---------- 5. OTP 端点可用（全链路属上线验收）----------
    s, r = call(base, 'POST', '/api/collections/admin_accounts/request-otp',
                {'email': 'aemadmin1@it.cc.local'})
    rep.check('AEM-14 request-otp → 200 且返回 otpId（OTP 已启用）',
              s == 200 and bool(r.get('otpId')), r)

    # ---------- 6. 直连改邮箱被 guards 禁止（换邮箱走 requestEmailChange）----------
    _, AT = fx.create_admin_via_impersonate(base, st, org, 'aem_admin_3')
    s, me = call(base, 'GET',
                 "/api/collections/admin_accounts/records?filter=(username='aem_admin_3')", token=AT)
    my_id = (me.get('items') or [{}])[0].get('id')
    s, r = call(base, 'PATCH', '/api/collections/admin_accounts/records/%s' % my_id,
                {'email': 'aem_admin_3_new@it.cc.local'}, AT)
    rep.check('AEM-15 管理员直连改本人 email → 403（guards 禁改清单）', s == 403, r)
