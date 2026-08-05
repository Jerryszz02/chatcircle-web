# -*- coding: utf-8 -*-
"""suite_capacity — 名额事务硬校验与并发审核（AC-08、FR-ACT-006/007、FR-REG-005）。

断言：
- 角色名额满 / 总名额满时审核通过被拒绝（事务内校验），名额计数不变；
- 新报名口径：总名额满拒绝全部新报名、角色名额满拒绝该角色（FR-ACT-007）；
- 审核时修改 activity_role 撞目标角色满额 → 拒绝（FR-REG-005）；
- 两名管理员并发通过不同报名（剩余名额 1）→ 恰好一个成功，终态不超额；
- capacity_* 修改不得低于当前已通过数（FR-ACT-006）。
"""
import threading
from concurrent.futures import ThreadPoolExecutor

import cc_fixture as fx
from cc_client import biz_code, call


def _approved_count(base, at):
    """经看板口径读当前已通过数（机构隔离注入，等值于服务端计数）。"""
    _, m = call(base, 'GET', '/api/cc/metrics/approvals', token=at)
    return m.get('value')


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    fields = ctx['fields']
    rep.section('suite_capacity：名额事务硬校验与并发审核（AC-08）')

    org = fx.create_org(base, st, '名额机构')
    _, AT = fx.create_admin(base, st, org, 'cap_admin_1')
    _, AT2 = fx.create_admin(base, st, org, 'cap_admin_2')

    # ---------- 1. 角色/总名额满拒绝通过 ----------
    act = fx.create_activity(base, AT, org, 'CC_IT_CAP_01', '名额硬校验场',
                             fields=fx.nick_field_cfg(fields), caps=(2, 1, 1))
    regs = {}
    for i, role in enumerate(('speaker', 'speaker', 'listener', 'listener'), 1):
        _, pt, _ = fx.create_participant(base, 'cap_u%d' % i)
        regs[i] = fx.register(base, pt, act, role, fx.field_answers(fields, '名额%d' % i))

    s, r = fx.transition(base, AT, regs[1], 'approved')
    rep.check('CAP-01 首名倾诉者通过', s == 200, r)
    s, r = fx.transition(base, AT, regs[2], 'approved')
    rep.check('CAP-02 倾诉者名额满 → 409 ROLE_CAPACITY_FULL',
              s == 409 and biz_code(r) == 'ROLE_CAPACITY_FULL', r)
    s, r = fx.transition(base, AT, regs[3], 'approved')
    rep.check('CAP-03 聆听者通过（总名额随之占满 2/2）', s == 200, r)
    s, r = fx.transition(base, AT, regs[4], 'approved')
    rep.check('CAP-04 总名额满 → 409 CAPACITY_FULL', s == 409 and biz_code(r) == 'CAPACITY_FULL', r)
    rep.check('CAP-05 拒绝后已通过计数不变（=2）', _approved_count(base, AT) == 2,
              _approved_count(base, AT))

    # 新报名口径（FR-ACT-007）：总满拒全部新报名
    _, pt5, _ = fx.create_participant(base, 'cap_u5')
    s, r = call(base, 'POST', '/api/cc/activities/%s/register' % act,
                {'activity_role': 'listener', 'answers': fx.field_answers(fields, '名额5')}, pt5)
    rep.check('CAP-06 总名额满时新报名 → 409 CAPACITY_FULL',
              s == 409 and biz_code(r) == 'CAPACITY_FULL', r)

    # ---------- 2. 名额修改下限（FR-ACT-006）----------
    s, r = call(base, 'PATCH', '/api/collections/activities/records/%s' % act,
                {'capacity_total': 1}, AT)
    rep.check('CAP-07 capacity_total 调低于已通过数 → 400', s == 400, r)
    s, r = call(base, 'PATCH', '/api/collections/activities/records/%s' % act,
                {'capacity_speaker': 0}, AT)
    rep.check('CAP-08 capacity_speaker 调低于已通过数 → 400', s == 400, r)
    s, r = call(base, 'PATCH', '/api/collections/activities/records/%s' % act,
                {'capacity_total': 4}, AT)
    rep.check('CAP-09 调高名额允许（≥已通过数）', s == 200, r)

    # ---------- 3. 审核时改角色撞目标角色满额（FR-REG-005）----------
    act2 = fx.create_activity(base, AT, org, 'CC_IT_CAP_02', '角色修改校验场',
                              fields=fx.nick_field_cfg(fields), caps=(5, 1, 5))
    _, pt6, _ = fx.create_participant(base, 'cap_u6')
    _, pt7, _ = fx.create_participant(base, 'cap_u7')
    reg6 = fx.register(base, pt6, act2, 'speaker', fx.field_answers(fields, '角色6'))
    reg7 = fx.register(base, pt7, act2, 'listener', fx.field_answers(fields, '角色7'))
    s, r = fx.transition(base, AT, reg6, 'approved')
    rep.check('CAP-10 倾诉者通过（speaker 满 1/1）', s == 200, r)
    s, r = fx.transition(base, AT, reg7, 'approved', role='speaker')
    rep.check('CAP-11 审核改角色撞 speaker 满额 → 409 ROLE_CAPACITY_FULL',
              s == 409 and biz_code(r) == 'ROLE_CAPACITY_FULL', r)
    s, r = fx.transition(base, AT, reg7, 'approved')
    rep.check('CAP-12 按原角色 listener 通过成功', s == 200, r)

    # ---------- 4. 并发审核不超额（剩余名额 1，两名管理员同时通过不同报名）----------
    act3 = fx.create_activity(base, AT, org, 'CC_IT_CAP_03', '并发审核场',
                              fields=fx.nick_field_cfg(fields), caps=(1, 1, 1))
    _, pt8, _ = fx.create_participant(base, 'cap_u8')
    _, pt9, _ = fx.create_participant(base, 'cap_u9')
    reg8 = fx.register(base, pt8, act3, 'speaker', fx.field_answers(fields, '并发8'))
    reg9 = fx.register(base, pt9, act3, 'listener', fx.field_answers(fields, '并发9'))

    barrier = threading.Barrier(3)

    def approve(token, reg_id):
        barrier.wait()  # 两线程与主线程同点起跑，最大化事务竞争
        return fx.transition(base, token, reg_id, 'approved')

    with ThreadPoolExecutor(max_workers=2) as pool:
        f1 = pool.submit(approve, AT, reg8)
        f2 = pool.submit(approve, AT2, reg9)
        barrier.wait()
        res = [f1.result(), f2.result()]

    codes = sorted(x[0] for x in res)
    biz = [biz_code(x[1]) for x in res]
    loser = next((x for x in res if x[0] != 200), None)
    rep.check('CAP-13 并发审核恰好一个 200、另一个 409 CAPACITY_FULL',
              codes == [200, 409] and loser is not None and biz_code(loser[1]) == 'CAPACITY_FULL',
              list(zip(codes, biz)))
    s2, r2 = call(base, 'GET',
                  f"/api/collections/registrations/records?perPage=100&filter=(activity_id='{act3}'%26%26status='approved')",
                  token=AT)
    rep.check('CAP-14 并发场终态已通过数 ≤ 名额（=1，不超额）',
              s2 == 200 and r2.get('totalItems') == 1, r2)
