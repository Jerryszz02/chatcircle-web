# -*- coding: utf-8 -*-
"""suite_transitions — 报名状态迁移矩阵（AC-07、PRD §4.4、FR-REG-007/008）。

矩阵内 5 种迁移：pending→approved / pending→rejected / approved→cancelled /
rejected→approved / cancelled→approved。
断言：
- 5 种合法迁移成功；矩阵外全部组合拒绝（ILLEGAL_TRANSITION）；
- 回退/取消缺原因即拒绝（REASON_REQUIRED）；
- 回退重新执行名额硬校验（满额时回退拒绝）；
- 合法迁移写入 audit_logs（操作者、前后状态、原因，FR-REG-008）；
- 同态迁移幂等返回（already=true）。
"""
import cc_fixture as fx
from cc_client import biz_code, call

ALL_STATES = ('pending', 'approved', 'rejected', 'cancelled')
LEGAL = {('pending', 'approved'), ('pending', 'rejected'), ('approved', 'cancelled'),
         ('rejected', 'approved'), ('cancelled', 'approved')}


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    fields = ctx['fields']
    rep.section('suite_transitions：报名状态迁移矩阵（AC-07）')

    org = fx.create_org(base, st, '矩阵机构')
    admin_id, AT = fx.create_admin(base, st, org, 'tran_admin')
    act = fx.create_activity(base, AT, org, 'CC_IT_TRAN_01', '状态矩阵场',
                             fields=fx.nick_field_cfg(fields), caps=(20, 10, 10))

    n = 0

    def new_reg():
        nonlocal n
        n += 1
        _, pt, _ = fx.create_participant(base, 'tran_u%d' % n)
        return fx.register(base, pt, act, 'speaker', fx.field_answers(fields, '矩阵%d' % n))

    # ---------- 1. 五种合法迁移 ----------
    r1 = new_reg()
    s, r = fx.transition(base, AT, r1, 'approved')
    rep.check('TRAN-01 pending→approved 合法', s == 200 and r.get('registration', {}).get('status') == 'approved', r)
    s, r = fx.transition(base, AT, r1, 'cancelled', reason='线下申请取消')
    rep.check('TRAN-02 approved→cancelled（带原因）合法', s == 200, r)
    s, r = fx.transition(base, AT, r1, 'approved', reason='纠正误判恢复')
    rep.check('TRAN-03 cancelled→approved（带原因）合法', s == 200, r)

    r2 = new_reg()
    s, r = fx.transition(base, AT, r2, 'rejected')
    rep.check('TRAN-04 pending→rejected 合法', s == 200, r)
    s, r = fx.transition(base, AT, r2, 'approved', reason='误判回退')
    rep.check('TRAN-05 rejected→approved（带原因）合法', s == 200, r)

    # ---------- 2. 矩阵外全部组合枚举（4×4 − 5合法 − 4同态 = 7 种非法）----------
    # 各状态基准备一份报名
    base_regs = {'pending': new_reg(), 'approved': new_reg(), 'rejected': new_reg(),
                 'cancelled': new_reg()}
    fx.transition(base, AT, base_regs['approved'], 'approved')
    fx.transition(base, AT, base_regs['rejected'], 'rejected')
    fx.transition(base, AT, base_regs['cancelled'], 'approved')
    fx.transition(base, AT, base_regs['cancelled'], 'cancelled', reason='预备取消')

    idx = 5
    for frm in ALL_STATES:
        for to in ALL_STATES:
            if frm == to or (frm, to) in LEGAL:
                continue
            idx += 1
            s, r = fx.transition(base, AT, base_regs[frm], to,
                                 reason='尝试非法迁移')
            rep.check('TRAN-%02d 非法迁移 %s→%s → 400 ILLEGAL_TRANSITION' % (idx, frm, to),
                      s == 400 and biz_code(r) == 'ILLEGAL_TRANSITION', r)

    # ---------- 3. 原因必填（FR-REG-008）----------
    idx = 12
    r3 = new_reg()
    fx.transition(base, AT, r3, 'approved')
    s, r = fx.transition(base, AT, r3, 'cancelled')
    rep.check('TRAN-13 approved→cancelled 缺原因 → 400 REASON_REQUIRED',
              s == 400 and biz_code(r) == 'REASON_REQUIRED', r)
    r4 = new_reg()
    fx.transition(base, AT, r4, 'rejected')
    s, r = fx.transition(base, AT, r4, 'approved')
    rep.check('TRAN-14 rejected→approved 缺原因 → 400 REASON_REQUIRED',
              s == 400 and biz_code(r) == 'REASON_REQUIRED', r)
    r5 = new_reg()
    fx.transition(base, AT, r5, 'approved')
    fx.transition(base, AT, r5, 'cancelled', reason='预备')
    s, r = fx.transition(base, AT, r5, 'approved')
    rep.check('TRAN-15 cancelled→approved 缺原因 → 400 REASON_REQUIRED',
              s == 400 and biz_code(r) == 'REASON_REQUIRED', r)

    # ---------- 4. 审计留痕：操作者 / 前后状态 / 原因 ----------
    s, r = call(base, 'GET',
                f"/api/collections/audit_logs/records?filter=(action='registration.cancel'%26%26target_id='{r1}')",
                token=st)
    items = r.get('items') or []
    meta = (items[0].get('metadata') or {}) if items else {}
    rep.check('TRAN-16 取消迁移写审计（action/操作者/前后状态/原因）',
              s == 200 and len(items) == 1
              and items[0].get('actor_id') == admin_id
              and items[0].get('actor_role') == 'admin'
              and items[0].get('reason') == '线下申请取消'
              and meta.get('from') == 'approved' and meta.get('to') == 'cancelled',
              items)
    s, r = call(base, 'GET',
                f"/api/collections/audit_logs/records?filter=(action='registration.status_revert'%26%26target_id='{r2}')",
                token=st)
    items = r.get('items') or []
    rep.check('TRAN-17 回退迁移写审计（registration.status_revert）',
              s == 200 and len(items) == 1 and items[0].get('reason') == '误判回退', items)

    # ---------- 5. 回退重新执行名额硬校验 ----------
    act2 = fx.create_activity(base, AT, org, 'CC_IT_TRAN_02', '回退名额校验场',
                              fields=fx.nick_field_cfg(fields), caps=(2, 1, 1))
    _, pt_a, _ = fx.create_participant(base, 'tran_fill')
    _, pt_a2, _ = fx.create_participant(base, 'tran_fill2')
    _, pt_b, _ = fx.create_participant(base, 'tran_rev')
    reg_fill = fx.register(base, pt_a, act2, 'speaker', fx.field_answers(fields, '占位'))
    reg_fill2 = fx.register(base, pt_a2, act2, 'listener', fx.field_answers(fields, '占位2'))
    reg_rev = fx.register(base, pt_b, act2, 'listener', fx.field_answers(fields, '回退'))
    fx.transition(base, AT, reg_fill, 'approved')   # 占满倾诉者名额
    fx.transition(base, AT, reg_fill2, 'approved')  # 占满总名额 2/2
    fx.transition(base, AT, reg_rev, 'rejected')
    s, r = fx.transition(base, AT, reg_rev, 'approved', reason='纠正误判')
    rep.check('TRAN-18 名额满时回退（rejected→approved）→ 409 CAPACITY_FULL',
              s == 409 and biz_code(r) == 'CAPACITY_FULL', r)

    # ---------- 6. 同态迁移幂等 ----------
    s, r = fx.transition(base, AT, reg_fill, 'approved')
    rep.check('TRAN-19 已是目标状态 → 幂等返回 already=true',
              s == 200 and r.get('already') is True, r)

    _onsite_transition_regression(ctx)


def _onsite_transition_regression(ctx):
    """T01: cancellation cannot leave a valid checkin/pair behind."""
    base, st, rep, fields = ctx['base'], ctx['st'], ctx['rep'], ctx['fields']
    org = fx.create_org(base, st, '现场状态一致性')
    _, at = fx.create_admin_via_impersonate(base, st, org, 'onsite_transition')
    act = fx.create_activity(base, at, org, 'CC_IT_TRAN_ONSITE', '现场迁移',
                             fields=fx.nick_field_cfg(fields), caps=(8, 4, 4))
    qr = fx.checkin_token(base, at, act)
    call(base, 'POST', '/api/cc/activities/%s/checkin/open' % act, {}, at)
    members = []
    for role in ('speaker', 'listener'):
        _, pt, _ = fx.create_participant(base, 'tran_onsite_' + role)
        reg = fx.register(base, pt, act, role, fx.field_answers(fields, role))
        assert fx.transition(base, at, reg, 'approved')[0] == 200
        status, checked = fx.self_checkin(base, qr, pt)
        assert status == 200, checked
        members.append((reg, pt))
    reg, pt = members[0]
    status, result = fx.transition(base, at, reg, 'cancelled', reason='直接取消')
    rep.check('TRAN-20 有效签到禁止直接取消',
              status == 409 and biz_code(result) == 'ONSITE_STATE_CONFLICT', result)
    # Restore the baseline fixture after demonstrating the vulnerable behavior.
    if status == 200:
        fx.transition(base, at, reg, 'approved', reason='复现后恢复')
    call(base, 'POST', '/api/cc/activities/%s/pairings/start' % act, {}, at)
    status, before = call(base, 'GET', '/api/cc/activities/%s/my-pairing' % act, token=pt)
    assert status == 200, before
    status, result = fx.transition(base, at, reg, 'cancelled', reason='已有搭档')
    rep.check('TRAN-21 已配对禁止直接取消',
              status == 409 and biz_code(result) == 'ONSITE_STATE_CONFLICT', result)
    _, current = call(base, 'GET', '/api/collections/registrations/records/' + reg, token=st)
    _, after = call(base, 'GET', '/api/cc/activities/%s/my-pairing' % act, token=pt)
    # updated_at is the response generation time, not the pairing identity.
    before.pop('updated_at', None)
    after.pop('updated_at', None)
    rep.check('TRAN-22 拒绝后报名仍通过且参与者配对未改变',
              current.get('status') == 'approved' and after == before, [current, before, after])
    if status == 200:
        fx.transition(base, at, reg, 'approved', reason='复现后恢复')
    # Model an inconsistent historical registration created by the old transition path.
    seed_status, seed = call(base, 'PATCH', '/api/collections/registrations/records/' + reg,
                             {'status': 'cancelled'}, st)
    assert seed_status == 200, seed
    status, result = fx.transition(base, at, reg, 'approved', reason='历史记录改角色', role='listener')
    rep.check('TRAN-22b 历史取消记录仍有现场状态时禁止改角色',
              status == 409 and biz_code(result) == 'ONSITE_STATE_CONFLICT', result)
    call(base, 'PATCH', '/api/collections/registrations/records/' + reg,
         {'status': 'approved', 'activity_role': 'speaker'}, st)
    _, rows = call(base, 'GET',
                   "/api/collections/checkins/records?filter=(registration_id='%s')" % reg, token=st)
    checkin = rows['items'][0]
    status, result = call(base, 'POST', '/api/cc/checkins/%s/revoke' % checkin['id'],
                          {'reason': '先撤销现场参与'}, at)
    assert status == 200, result
    status, result = fx.transition(base, at, reg, 'cancelled', reason='撤销后取消')
    rep.check('TRAN-23 受审计撤销签到后可以取消', status == 200, result)
    status, result = fx.transition(base, at, reg, 'approved', reason='撤销后改角色', role='listener')
    rep.check('TRAN-24 撤销后重新通过可改角色',
              status == 200 and result.get('registration', {}).get('activity_role') == 'listener', result)
    _, history = call(base, 'GET', '/api/collections/checkins/records/' + checkin['id'], token=st)
    rep.check('TRAN-25 撤销的历史签到保留原现场角色',
              history.get('status') == 'revoked' and history.get('onsite_role') == 'speaker', history)
