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
                              fields=fx.nick_field_cfg(fields), caps=(1, 1, 1))
    _, pt_a, _ = fx.create_participant(base, 'tran_fill')
    _, pt_b, _ = fx.create_participant(base, 'tran_rev')
    reg_fill = fx.register(base, pt_a, act2, 'speaker', fx.field_answers(fields, '占位'))
    reg_rev = fx.register(base, pt_b, act2, 'listener', fx.field_answers(fields, '回退'))
    fx.transition(base, AT, reg_fill, 'approved')  # 占满唯一名额
    fx.transition(base, AT, reg_rev, 'rejected')
    s, r = fx.transition(base, AT, reg_rev, 'approved', reason='纠正误判')
    rep.check('TRAN-18 名额满时回退（rejected→approved）→ 409 CAPACITY_FULL',
              s == 409 and biz_code(r) == 'CAPACITY_FULL', r)

    # ---------- 6. 同态迁移幂等 ----------
    s, r = fx.transition(base, AT, reg_fill, 'approved')
    rep.check('TRAN-19 已是目标状态 → 幂等返回 already=true',
              s == 200 and r.get('already') is True, r)
