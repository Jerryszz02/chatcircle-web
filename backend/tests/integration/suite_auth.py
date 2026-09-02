# -*- coding: utf-8 -*-
"""suite_auth — 存量参与者登录、登录限流与邀请码（AC-06/AC-21/AC-02）。

断言：
- 用户名规则（4–20 位字母/数字/下划线）服务端校验；
- 用户名小写归一 + 大小写不敏感唯一；未知用户名不得建号或获得 token；
- 已有用户名校验密码，错误密码不创建重复账号；
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
    rep.section('suite_auth：存量登录限流/邀请码（AC-06/21/02）')

    # ---------- 1. 用户名规则与大小写不敏感唯一（AC-06）----------
    for bad in ('abc', 'has space', 'x' * 21, 'user-name!'):
        s, r = call(base, 'POST', '/api/cc/auth/participant', {'username': bad, 'password': fx.PASSWORD})
        rep.check('AUTH-01 非法用户名 %r → 400 INVALID_USERNAME' % bad,
                  s == 400 and biz_code(r) == 'INVALID_USERNAME', r)
    s, r = call(base, 'POST', '/api/cc/auth/participant',
                {'username': 'UnknownUser01', 'password': fx.PASSWORD})
    rep.check('AUTH-02 未知用户名 → 400 INVALID_CREDENTIALS 且不签发 token',
              s == 400 and biz_code(r) == 'INVALID_CREDENTIALS'
              and 'record' not in r and 'token' not in r, r)
    s, r = call(base, 'GET',
                "/api/collections/participant_accounts/records?filter=(username='unknownuser01')", token=st)
    rep.check('AUTH-03 未知用户名不会创建未绑定账号',
              s == 200 and r.get('totalItems') == 0, r)

    uid, _, _ = fx.create_participant(base, 'mixedcase01')
    s, r = call(base, 'POST', '/api/cc/auth/participant',
                {'username': 'MIXEDCASE01', 'password': fx.PASSWORD})
    rep.check('AUTH-04 大小写变体登录已有账号（created=false，id 相同）',
              s == 200 and r.get('created') is False and (r.get('record') or {}).get('id') == uid, r)
    s, r = call(base, 'POST', '/api/cc/auth/participant',
                {'username': 'mixedcase01', 'password': 'wrong_pass_999'})
    rep.check('AUTH-05 错误密码 → 400 INVALID_CREDENTIALS',
              s == 400 and biz_code(r) == 'INVALID_CREDENTIALS', r)
    s, r = call(base, 'GET',
                "/api/collections/participant_accounts/records?filter=(username='mixedcase01')", token=st)
    rep.check('AUTH-06 错误密码不产生重复账号（仍 1 条）',
              s == 200 and r.get('totalItems') == 1, r)

    # ---------- 2. 登录限流（AC-21：5 次失败 / 10 分钟窗口）----------
    fx.create_participant(base, 'rl_user01')
    codes = []
    for _ in range(5):
        s, r = call(base, 'POST', '/api/cc/auth/participant',
                    {'username': 'rl_user01', 'password': 'wrong_pass_999'})
        codes.append(s)
    rep.check('AUTH-07 前 5 次错误密码均 400 INVALID_CREDENTIALS',
              codes == [400] * 5 and biz_code(r) == 'INVALID_CREDENTIALS', codes)
    s, r = call(base, 'POST', '/api/cc/auth/participant',
                {'username': 'rl_user01', 'password': 'wrong_pass_999'})
    rep.check('AUTH-08 第 6 次失败触发限流 → 429 TOO_MANY_ATTEMPTS',
              s == 429 and biz_code(r) == 'TOO_MANY_ATTEMPTS', r)
    s, r = call(base, 'POST', '/api/cc/auth/participant',
                {'username': 'rl_user01', 'password': fx.PASSWORD})
    rep.check('AUTH-09 限流期间正确密码同样被拒（429）',
              s == 429 and biz_code(r) == 'TOO_MANY_ATTEMPTS', r)
    rep.check('AUTH-10 限流响应不携带账号信息（无 record/token 字段）',
              isinstance(r, dict) and 'record' not in r and 'token' not in r, r)

    # ---------- 2b. 并发失败不可突破阈值（CWE-362 回归，原子「检查即预占」）----------
    # 同一 username+IP 限流 max=5：并发打 max*2=10 次失败登录。原子「检查即预占」保证最多 5 次
    # 进入认证并返回 400（预占 5 格后，其余被 429 拦截）；此前非原子 get/set 会允许并发放行、
    # 计数相互覆盖而突破阈值。spray 桶只计失败、成功不计（成功回滚），此处失败均计入 spray，
    # 预算充足（阈值 30/IP）。
    fx.create_participant(base, 'rl_atomic_user')
    n_atomic = 10
    barrier2 = threading.Barrier(n_atomic + 1)

    def fail_login(_uname):
        barrier2.wait()
        return call(base, 'POST', '/api/cc/auth/participant',
                    {'username': 'rl_atomic_user', 'password': 'wrong_pass_999'})

    with ThreadPoolExecutor(max_workers=n_atomic) as pool:
        futs = [pool.submit(fail_login, 'rl_atomic_user') for _ in range(n_atomic)]
        barrier2.wait()
        res = [f.result() for f in futs]
    codes_atomic = [x[0] for x in res]
    rep.check('AUTH-18 并发 10 次失败登录：进入认证(400)次数不超过阈值 5，其余被 429 拦截',
              codes_atomic.count(400) <= 5 and codes_atomic.count(429) >= n_atomic - 5,
              sorted(codes_atomic))
    ok_400 = all(biz_code(x[1]) == 'INVALID_CREDENTIALS' for x in res if x[0] == 400)
    ok_429 = all(biz_code(x[1]) == 'TOO_MANY_ATTEMPTS' for x in res if x[0] == 429)
    rep.check('AUTH-19 并发限流错误码保持统一语义（400 均 INVALID_CREDENTIALS/429 均 TOO_MANY_ATTEMPTS）',
              ok_400 and ok_429 and set(codes_atomic) <= {400, 429}, res[:3])

    # ---------- 3. 邀请码（AC-02）----------
    org = fx.create_org(base, st, '邀请码机构')

    def new_invite():
        s2, r2 = call(base, 'POST', '/api/cc/super/invites', {'organization_id': org}, st)
        return r2.get('invite') or {}

    inv1 = new_invite()
    s, r = call(base, 'POST', '/api/cc/auth/admin-register',
                {'invite_code': inv1.get('token'), 'username': 'AuthAdmin1',
                 'email': 'authadmin1@it.cc.local', 'password': fx.PASSWORD})
    rep.check('AUTH-11 邀请码注册成功（用户名小写归一）',
              s == 200 and (r.get('record') or {}).get('username') == 'authadmin1', r)
    inv2 = new_invite()
    s, r = call(base, 'POST', '/api/cc/auth/admin-register',
                {'invite_code': inv2.get('token'), 'username': 'AUTHADMIN1',
                 'email': 'authadmin1b@it.cc.local', 'password': fx.PASSWORD})
    rep.check('AUTH-12 用户名重复（大小写不敏感）→ 400 USERNAME_TAKEN',
              s == 400 and biz_code(r) == 'USERNAME_TAKEN', r)
    s, r = call(base, 'POST', '/api/cc/auth/admin-register',
                {'invite_code': inv1.get('token'), 'username': 'other_admin',
                 'email': 'other_admin@it.cc.local', 'password': fx.PASSWORD})
    rep.check('AUTH-13 已使用邀请码 → 400 INVITE_INVALID',
              s == 400 and biz_code(r) == 'INVITE_INVALID', r)

    inv3 = new_invite()
    call(base, 'POST', '/api/cc/super/invites/%s/revoke' % inv3.get('id'), {}, st)
    s, r = call(base, 'POST', '/api/cc/auth/admin-register',
                {'invite_code': inv3.get('token'), 'username': 'revoked_user',
                 'email': 'revoked_user@it.cc.local', 'password': fx.PASSWORD})
    rep.check('AUTH-14 已撤销邀请码 → 400 INVITE_INVALID',
              s == 400 and biz_code(r) == 'INVITE_INVALID', r)

    # 过期：超管通道把 expires_at 改写为过去（固化由 hooks 注册路径完成）
    inv4 = new_invite()
    s, r = call(base, 'PATCH', '/api/collections/admin_invites/records/%s' % inv4.get('id'),
                {'expires_at': '2020-01-01 00:00:00.000Z'}, st)
    s, r = call(base, 'POST', '/api/cc/auth/admin-register',
                {'invite_code': inv4.get('token'), 'username': 'expired_user',
                 'email': 'expired_user@it.cc.local', 'password': fx.PASSWORD})
    rep.check('AUTH-15 已过期邀请码 → 400 INVITE_EXPIRED',
              s == 400 and biz_code(r) == 'INVITE_EXPIRED', r)
    s, r = call(base, 'GET', '/api/collections/admin_invites/records/%s' % inv4.get('id'), token=st)
    rep.check('AUTH-16 过期状态固化（status=expired，PRD §4.2 四态）',
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
    rep.check('AUTH-17 并发使用同一邀请码：恰好一个 200、另一个 400 INVITE_INVALID',
              codes == [200, 400] and loser is not None
              and biz_code(loser[1]) == 'INVITE_INVALID',
              [(x[0], biz_code(x[1])) for x in res])
