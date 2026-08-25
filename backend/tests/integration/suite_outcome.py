# -*- coding: utf-8 -*-
"""suite_outcome — 公开 Outcome 端点 GET /api/cc/public/outcome（AC-26，2026-08 后端改版）。

端点为全平台累计口径、匿名只读、无手工维护，精确值受其他套件 fixture 影响，
故本套件一律用**增量断言**（先取基线，再逐步造数，断言差值）。

口径（technical-design §5.5/§5.6）：
- activity_sessions：已发布/已关闭/已归档活动数（草稿/待审核/已驳回/已下架不计）；
- service_visits：有效签到记录数（checkins.status='valid'，撤销/无效不计）；
- partner_organizations：状态 active 的机构数（停用不计）。
"""
import cc_fixture as fx
from cc_client import call


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    fields = ctx['fields']
    rep.section('suite_outcome：公开 Outcome 端点（AC-26）')

    def outcome():
        s2, r2 = call(base, 'GET', '/api/cc/public/outcome')
        assert s2 == 200, 'outcome 端点不可用：%s' % r2
        return r2

    # ---------- 1. 匿名可用性与响应形态 ----------
    s, r = call(base, 'GET', '/api/cc/public/outcome')
    rep.check('OUT-01 匿名 200 且三项指标齐全且为整数',
              s == 200 and all(isinstance(r.get(k), int) for k in
                               ('activity_sessions', 'service_visits', 'partner_organizations')), r)
    b = outcome()

    # ---------- 2. partner_organizations：active 机构 +1，停用回落 ----------
    org = fx.create_org(base, st, 'Outcome机构')
    rep.check('OUT-02 新增 active 机构 → partner_organizations +1',
              outcome()['partner_organizations'] == b['partner_organizations'] + 1, outcome())
    s, r = call(base, 'PATCH', '/api/collections/organizations/records/%s' % org,
                {'status': 'disabled'}, st)
    rep.check('OUT-03 机构停用 → partner_organizations 回落基线',
              s == 200 and outcome()['partner_organizations'] == b['partner_organizations'], r)
    call(base, 'PATCH', '/api/collections/organizations/records/%s' % org,
         {'status': 'active'}, st)  # 恢复，供后续活动/签到 fixture 使用

    # ---------- 3. activity_sessions：仅 published/closed/archived 计入 ----------
    _, AT = fx.create_admin_via_impersonate(base, st, org, 'out_admin')
    fx.create_activity(base, AT, org, 'CC_IT_OUT_01', 'Outcome 草稿场',
                       fields=fx.nick_field_cfg(fields), publish=False)
    rep.check('OUT-04 草稿活动不计入 activity_sessions',
              outcome()['activity_sessions'] == b['activity_sessions'], outcome())

    act_pub = fx.create_activity(base, AT, org, 'CC_IT_OUT_02', 'Outcome 发布场',
                                 fields=fx.nick_field_cfg(fields))
    rep.check('OUT-05 已发布活动计入 → +1',
              outcome()['activity_sessions'] == b['activity_sessions'] + 1, outcome())

    # ---------- 4. service_visits：有效签到 +1（对已发布活动走完整报名/签到链路）----------
    P, PT, _ = fx.create_participant(base, 'out_user')
    reg = fx.register(base, PT, act_pub, 'speaker', fx.field_answers(fields, '口径'))
    fx.transition(base, AT, reg, 'approved')
    call(base, 'POST', '/api/cc/activities/%s/checkin/open' % act_pub, {}, AT)
    s, ck = fx.self_checkin(base, fx.checkin_token(base, AT, act_pub), PT)
    rep.check('OUT-06 有效签到 → service_visits +1',
              s == 200 and outcome()['service_visits'] == b['service_visits'] + 1, ck)

    # ---------- 5. closed / archived / taken_down 口径 ----------
    s, r = call(base, 'POST', '/api/cc/activities/%s/close' % act_pub, {}, AT)
    rep.check('OUT-07 已关闭活动仍计入（published→closed 不变）',
              s == 200 and outcome()['activity_sessions'] == b['activity_sessions'] + 1, r)
    s, r = call(base, 'POST', '/api/cc/activities/%s/archive' % act_pub, {}, AT)
    rep.check('OUT-08 已归档活动仍计入（closed→archived 不变）',
              s == 200 and outcome()['activity_sessions'] == b['activity_sessions'] + 1, r)

    # 下架不计入：发布后下架 → 先 +1 再回落
    act_down = fx.create_activity(base, AT, org, 'CC_IT_OUT_03', 'Outcome 下架场',
                                  fields=fx.nick_field_cfg(fields))
    rep.check('OUT-09 第二场发布 → 再 +1',
              outcome()['activity_sessions'] == b['activity_sessions'] + 2, outcome())
    s, r = call(base, 'POST', '/api/cc/activities/%s/unpublish' % act_down, {}, st)
    rep.check('OUT-10 超管下架后不计入（taken_down 回落）',
              s == 200 and outcome()['activity_sessions'] == b['activity_sessions'] + 1, r)
