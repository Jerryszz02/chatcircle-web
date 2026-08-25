# -*- coding: utf-8 -*-
"""suite_auth — 参与者自动注册/登录、登录限流与邀请码（AC-06/AC-21/AC-02、FR-AUTH-001~008）。

断言：
- 用户名规则（4–20 位字母/数字/下划线）服务端校验；
- 用户名小写归一 + 大小写不敏感唯一；新名自动建号、老名校验密码；
- 错误密码不创建重复账号；
- 登录限流：同 username+IP 连续 5 次失败后第 6 次起 429，限流期间正确密码同样被拒，
  且限流响应不携带账号信息（不泄露账号是否存在）；
- 邀请码一次性：已用/已撤销/已过期均不可注册；并发使用同一邀请码仅一次成功。
"""
import threading
from concurrent.futures import ThreadPoolExecutor

import cc_fixture as fx
from cc_client import biz_code, call


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    rep.section('suite_auth：自动注册/登录限流/邀请码（AC-06/21/02）')

    # ---------- 1. 用户名规则与大小写不敏感唯一（AC-06）----------
    for bad in ('abc', 'has space', 'x' * 21, 'user-name!'):
        s, r = call(base, 'POST', '/api/cc/auth/participant', {'username': bad, 'password': fx.PASSWORD})
        rep.check('AUTH-01 非法用户名 %r → 400 INVALID_USERNAME' % bad,
                  s == 400 and biz_code(r) == 'INVALID_USERNAME', r)
    s, r = call(base, 'POST', '/api/cc/auth/participant',
                {'username': 'MixedCase01', 'password': fx.PASSWORD})
    uid = (r.get('record') or {}).get('id')
    rep.check('AUTH-02 新用户名自动建号（created=true，存储小写）',
              s == 200 and r.get('created') is True
              and (r.get('record') or {}).get('username') == 'mixedcase01', r)
    s, r = call(base, 'POST', '/api/cc/auth/participant',
                {'username': 'MIXEDCASE01', 'password': fx.PASSWORD})
    rep.check('AUTH-03 大小写变体登录同一账号（created=false，id 相同）',
              s == 200 and r.get('created') is False and (r.get('record') or {}).get('id') == uid, r)
    s, r = call(base, 'POST', '/api/cc/auth/participant',
                {'username': 'mixedcase01', 'password': 'wrong_pass_999'})
    rep.check('AUTH-04 错误密码 → 400 INVALID_CREDENTIALS',
              s == 400 and biz_code(r) == 'INVALID_CREDENTIALS', r)
    s, r = call(base, 'GET',
                "/api/collections/participant_accounts/records?filter=(username='mixedcase01')", token=st)
    rep.check('AUTH-05 错误密码不产生重复账号（仍 1 条）',
              s == 200 and r.get('totalItems') == 1, r)

    # ---------- 2. 登录限流（AC-21：5 次失败 / 10 分钟窗口）----------
    fx.create_participant(base, 'rl_user01')
    codes = []
    for _ in range(5):
        s, r = call(base, 'POST', '/api/cc/auth/participant',
                    {'username': 'rl_user01', 'password': 'wrong_pass_999'})
        codes.append(s)
    rep.check('AUTH-06 前 5 次错误密码均 400 INVALID_CREDENTIALS',
              codes == [400] * 5 and biz_code(r) == 'INVALID_CREDENTIALS', codes)
    s, r = call(base, 'POST', '/api/cc/auth/participant',
                {'username': 'rl_user01', 'password': 'wrong_pass_999'})
    rep.check('AUTH-07 第 6 次失败触发限流 → 429 TOO_MANY_ATTEMPTS',
              s == 429 and biz_code(r) == 'TOO_MANY_ATTEMPTS', r)
    s, r = call(base, 'POST', '/api/cc/auth/participant',
                {'username': 'rl_user01', 'password': fx.PASSWORD})
    rep.check('AUTH-08 限流期间正确密码同样被拒（429）',
              s == 429 and biz_code(r) == 'TOO_MANY_ATTEMPTS', r)
    rep.check('AUTH-09 限流响应不携带账号信息（无 record/token 字段）',
              isinstance(r, dict) and 'record' not in r and 'token' not in r, r)

    # ---------- 3. 邀请码（AC-02）----------
    org = fx.create_org(base, st, '邀请码机构')

    def new_invite():
        s2, r2 = call(base, 'POST', '/api/cc/super/invites', {'organization_id': org}, st)
        return r2.get('invite') or {}

    inv1 = new_invite()
    s, r = call(base, 'POST', '/api/cc/auth/admin-register',
                {'invite_code': inv1.get('token'), 'username': 'AuthAdmin1',
                 'email': 'authadmin1@it.cc.local', 'password': fx.PASSWORD})
    rep.check('AUTH-10 邀请码注册成功（用户名小写归一）',
              s == 200 and (r.get('record') or {}).get('username') == 'authadmin1', r)
    inv2 = new_invite()
    s, r = call(base, 'POST', '/api/cc/auth/admin-register',
                {'invite_code': inv2.get('token'), 'username': 'AUTHADMIN1',
                 'email': 'authadmin1b@it.cc.local', 'password': fx.PASSWORD})
    rep.check('AUTH-11 用户名重复（大小写不敏感）→ 400 USERNAME_TAKEN',
              s == 400 and biz_code(r) == 'USERNAME_TAKEN', r)
    s, r = call(base, 'POST', '/api/cc/auth/admin-register',
                {'invite_code': inv1.get('token'), 'username': 'other_admin',
                 'email': 'other_admin@it.cc.local', 'password': fx.PASSWORD})
    rep.check('AUTH-12 已使用邀请码 → 400 INVITE_INVALID',
              s == 400 and biz_code(r) == 'INVITE_INVALID', r)

    inv3 = new_invite()
    call(base, 'POST', '/api/cc/super/invites/%s/revoke' % inv3.get('id'), {}, st)
    s, r = call(base, 'POST', '/api/cc/auth/admin-register',
                {'invite_code': inv3.get('token'), 'username': 'revoked_user',
                 'email': 'revoked_user@it.cc.local', 'password': fx.PASSWORD})
    rep.check('AUTH-13 已撤销邀请码 → 400 INVITE_INVALID',
              s == 400 and biz_code(r) == 'INVITE_INVALID', r)

    # 过期：超管通道把 expires_at 改写为过去（固化由 hooks 注册路径完成）
    inv4 = new_invite()
    s, r = call(base, 'PATCH', '/api/collections/admin_invites/records/%s' % inv4.get('id'),
                {'expires_at': '2020-01-01 00:00:00.000Z'}, st)
    s, r = call(base, 'POST', '/api/cc/auth/admin-register',
                {'invite_code': inv4.get('token'), 'username': 'expired_user',
                 'email': 'expired_user@it.cc.local', 'password': fx.PASSWORD})
    rep.check('AUTH-14 已过期邀请码 → 400 INVITE_EXPIRED',
              s == 400 and biz_code(r) == 'INVITE_EXPIRED', r)
    s, r = call(base, 'GET', '/api/collections/admin_invites/records/%s' % inv4.get('id'), token=st)
    rep.check('AUTH-15 过期状态固化（status=expired，PRD §4.2 四态）',
              s == 200 and r.get('status') == 'expired', r)

    # 并发使用同一邀请码仅一次成功
    inv5 = new_invite()
    barrier = threading.Barrier(3)

    def use_invite(uname):
        barrier.wait()
        return call(base, 'POST', '/api/cc/auth/admin-register',
                    {'invite_code': inv5.get('token'), 'username': uname,
                     'email': '%s@it.cc.local' % uname, 'password': fx.PASSWORD})

    with ThreadPoolExecutor(max_workers=2) as pool:
        f1 = pool.submit(use_invite, 'race_admin1')
        f2 = pool.submit(use_invite, 'race_admin2')
        barrier.wait()
        res = [f1.result(), f2.result()]
    codes = sorted(x[0] for x in res)
    loser = next((x for x in res if x[0] != 200), None)
    rep.check('AUTH-16 并发使用同一邀请码：恰好一个 200、另一个 400 INVITE_INVALID',
              codes == [200, 400] and loser is not None
              and biz_code(loser[1]) == 'INVITE_INVALID',
              [(x[0], biz_code(x[1])) for x in res])
