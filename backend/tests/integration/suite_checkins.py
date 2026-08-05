# -*- coding: utf-8 -*-
"""suite_checkins — 签到唯一性、幂等与补签/撤销（AC-09/AC-10/AC-20、FR-CHK-001~006）。

断言：
- 仅「已通过 + 开放中 + 首次」产生签到；待审核/已拒绝扫码、未开放/已结束扫码全部拒绝；
- 重复扫码幂等返回已有记录（不报错不新建）；并发双扫终态仍一人一签；
- 补签/撤销原因必填 + 写审计；撤销保留原记录（状态=已撤销）；
- 撤销后可重新签到；有效签到口径（service_visits）随操作同步变化。
"""
import threading
from concurrent.futures import ThreadPoolExecutor

import cc_fixture as fx
from cc_client import biz_code, call


def _visits(base, at):
    _, m = call(base, 'GET', '/api/cc/metrics/service_visits', token=at)
    return m.get('value')


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    fields = ctx['fields']
    rep.section('suite_checkins：签到唯一/幂等/补签/撤销（AC-09/10/20）')

    org = fx.create_org(base, st, '签到机构')
    _, AT = fx.create_admin(base, st, org, 'chk_admin')
    act = fx.create_activity(base, AT, org, 'CC_IT_CHK_01', '签到校验场',
                             fields=fx.nick_field_cfg(fields), caps=(20, 10, 10))

    P1, PT1, _ = fx.create_participant(base, 'chk_u1')
    P2, PT2, _ = fx.create_participant(base, 'chk_u2')
    P3, PT3, _ = fx.create_participant(base, 'chk_u3')
    P4, PT4, _ = fx.create_participant(base, 'chk_u4')
    P5, PT5, _ = fx.create_participant(base, 'chk_u5')
    reg1 = fx.register(base, PT1, act, 'speaker', fx.field_answers(fields, '签到1'))
    reg2 = fx.register(base, PT2, act, 'listener', fx.field_answers(fields, '签到2'))
    reg3 = fx.register(base, PT3, act, 'listener', fx.field_answers(fields, '签到3'))
    reg4 = fx.register(base, PT4, act, 'speaker', fx.field_answers(fields, '签到4'))
    reg5 = fx.register(base, PT5, act, 'speaker', fx.field_answers(fields, '签到5'))
    fx.transition(base, AT, reg1, 'approved')
    fx.transition(base, AT, reg3, 'approved')
    fx.transition(base, AT, reg4, 'approved')
    fx.transition(base, AT, reg5, 'rejected')

    # ---------- 1. 前置校验 ----------
    s, r = call(base, 'POST', '/api/cc/checkin/%s/self' % act, {}, PT2)
    rep.check('CHK-01 待审核报名扫码 → 403 registration_not_approved',
              s == 403 and biz_code(r) == 'registration_not_approved', r)
    s, r = call(base, 'POST', '/api/cc/checkin/%s/self' % act, {}, PT5)
    rep.check('CHK-02 已拒绝报名扫码 → 403 registration_not_approved',
              s == 403 and biz_code(r) == 'registration_not_approved', r)
    s, r = call(base, 'POST', '/api/cc/checkin/%s/self' % act, {}, PT1)
    rep.check('CHK-03 签到未开放 → 400 checkin_not_open',
              s == 400 and biz_code(r) == 'checkin_not_open', r)

    # ---------- 2. 开放 → 首签 → 幂等重复 ----------
    s, r = call(base, 'POST', '/api/cc/activities/%s/checkin/open' % act, {}, AT)
    rep.check('CHK-04 管理员开放签到', s == 200, r)
    s, r = call(base, 'POST', '/api/cc/checkin/%s/self' % act, {}, PT1)
    ck1 = (r.get('checkin') or {}).get('id')
    rep.check('CHK-05 已通过者开放期首签成功（valid）',
              s == 200 and (r.get('checkin') or {}).get('status') == 'valid'
              and r.get('already_checked_in') is False, r)
    s, r = call(base, 'POST', '/api/cc/checkin/%s/self' % act, {}, PT1)
    rep.check('CHK-06 重复扫码幂等（同一记录，不新建）',
              s == 200 and r.get('already_checked_in') is True
              and (r.get('checkin') or {}).get('id') == ck1, r)
    rep.check('CHK-07 有效签到口径 = 1', _visits(base, AT) == 1, _visits(base, AT))

    # ---------- 3. 并发双扫：终态一人一签 ----------
    barrier = threading.Barrier(3)

    def scan():
        barrier.wait()
        return call(base, 'POST', '/api/cc/checkin/%s/self' % act, {}, PT3)

    with ThreadPoolExecutor(max_workers=2) as pool:
        f1 = pool.submit(scan)
        f2 = pool.submit(scan)
        barrier.wait()
        res = [f1.result(), f2.result()]
    rep.check('CHK-08 并发双扫均 200 且仅一条有效签到',
              all(x[0] == 200 for x in res) and _visits(base, AT) == 2,
              [(x[0], (x[1] or {}).get('already_checked_in')) for x in res] + [_visits(base, AT)])

    # ---------- 4. 关闭后扫码 ----------
    call(base, 'POST', '/api/cc/activities/%s/checkin/close' % act, {}, AT)
    s, r = call(base, 'POST', '/api/cc/checkin/%s/self' % act, {}, PT4)
    rep.check('CHK-09 签到已结束 → 400 checkin_closed',
              s == 400 and biz_code(r) == 'checkin_closed', r)
    s, r = call(base, 'POST', '/api/cc/checkin/%s/self' % act, {}, PT1)
    rep.check('CHK-10 已签到者关闭期重复扫码仍幂等返回（不报错）',
              s == 200 and r.get('already_checked_in') is True, r)

    # ---------- 5. 补签（AC-10）----------
    fx.transition(base, AT, reg2, 'approved')
    s, r = call(base, 'POST', '/api/cc/checkins/manual',
                {'activity_id': act, 'participant_id': P2}, AT)
    rep.check('CHK-11 补签缺原因 → 400 REASON_REQUIRED',
              s == 400 and biz_code(r) == 'REASON_REQUIRED', r)
    s, r = call(base, 'POST', '/api/cc/checkins/manual',
                {'activity_id': act, 'participant_id': P2, 'reason': '现场补录'}, AT)
    ck2 = (r.get('checkin') or {}).get('id')
    rep.check('CHK-12 补签成功（source=manual）',
              s == 200 and (r.get('checkin') or {}).get('source') == 'manual'
              and (r.get('checkin') or {}).get('status') == 'valid', r)
    s, r = call(base, 'POST', '/api/cc/checkins/manual',
                {'activity_id': act, 'participant_id': P2, 'reason': '重复补录'}, AT)
    rep.check('CHK-13 重复补签幂等（existing=true，不新建）',
              s == 200 and r.get('existing') is True and (r.get('checkin') or {}).get('id') == ck2, r)
    s, r = call(base, 'GET',
                f"/api/collections/audit_logs/records?filter=(action='checkin.manual'%26%26target_id='{ck2}')",
                token=st)
    items = r.get('items') or []
    rep.check('CHK-14 补签写审计（原因入审计）',
              s == 200 and len(items) == 1 and items[0].get('reason') == '现场补录', items)
    rep.check('CHK-15 补签后有效签到 = 3', _visits(base, AT) == 3, _visits(base, AT))

    # ---------- 6. 撤销（AC-10）：保留原记录 + 审计 + 口径同步 ----------
    s, r = call(base, 'POST', '/api/cc/checkins/%s/revoke' % ck1, {}, AT)
    rep.check('CHK-16 撤销缺原因 → 400 REASON_REQUIRED',
              s == 400 and biz_code(r) == 'REASON_REQUIRED', r)
    s, r = call(base, 'POST', '/api/cc/checkins/%s/revoke' % ck1, {'reason': '代签核查'}, AT)
    rep.check('CHK-17 撤销成功（status=revoked，不删行）',
              s == 200 and (r.get('checkin') or {}).get('status') == 'revoked', r)
    s, r = call(base, 'GET', '/api/collections/checkins/records/%s' % ck1, token=AT)
    rep.check('CHK-18 原签到记录保留可查（status=revoked + reason）',
              s == 200 and r.get('status') == 'revoked' and r.get('reason') == '代签核查', r)
    s, r = call(base, 'GET',
                f"/api/collections/audit_logs/records?filter=(action='checkin.revoke'%26%26target_id='{ck1}')",
                token=st)
    rep.check('CHK-19 撤销写审计', s == 200 and len(r.get('items') or []) == 1, r)
    rep.check('CHK-20 撤销后有效签到 = 2（口径同步）', _visits(base, AT) == 2, _visits(base, AT))

    # ---------- 7. 撤销后重新开放可再签 ----------
    call(base, 'POST', '/api/cc/activities/%s/checkin/open' % act, {}, AT)
    s, r = call(base, 'POST', '/api/cc/checkin/%s/self' % act, {}, PT1)
    rep.check('CHK-21 撤销后重新签到成功（新一条 valid）',
              s == 200 and (r.get('checkin') or {}).get('status') == 'valid'
              and r.get('already_checked_in') is False, r)
    rep.check('CHK-22 终态有效签到 = 3 且去重人数 = 3（每人恒一条）',
              _visits(base, AT) == 3, _visits(base, AT))
    _, m = call(base, 'GET', '/api/cc/metrics/unique_participants', token=AT)
    rep.check('CHK-23 unique_participants 去重口径 = 3', m.get('value') == 3, m)
