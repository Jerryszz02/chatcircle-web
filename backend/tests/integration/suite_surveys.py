# -*- coding: utf-8 -*-
"""suite_surveys — 问卷四条件资格、草稿/提交/锁定/幂等/作废（AC-11/AC-12/AC-20、FR-SUR-006~010）。

资格四条件（FR-SUR-006）：登录、报名已通过、角色匹配、开放中——缺一即拒；
未签到不强制（PRD §5.6）。
断言：资格分因下发、提交幂等且内容不被覆盖、提交后锁定（草稿拒绝）、
作废原因必填 + 审计 + 统计排除 + 记录保留、作废后不可重填。
"""
import cc_fixture as fx
from cc_client import biz_code, call


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    fields, ver_id = ctx['fields'], ctx['ver_id']
    rep.section('suite_surveys：问卷资格四条件与答卷生命周期（AC-11/12/20）')

    org = fx.create_org(base, st, '问卷机构')
    _, AT = fx.create_admin(base, st, org, 'surv_admin')
    act = fx.create_activity(base, AT, org, 'CC_IT_SURV_01', '问卷校验场',
                             fields=fx.nick_field_cfg(fields), caps=(20, 10, 10))

    _, PT1, _ = fx.create_participant(base, 'surv_u1')  # speaker 已通过（不签到，PRD §5.6 未签到不强制）
    _, PT2, _ = fx.create_participant(base, 'surv_u2')  # 待审核
    _, PT3, _ = fx.create_participant(base, 'surv_u3')  # listener 已通过
    reg1 = fx.register(base, PT1, act, 'speaker', fx.field_answers(fields, '问卷1'))
    fx.register(base, PT2, act, 'listener', fx.field_answers(fields, '问卷2'))
    reg3 = fx.register(base, PT3, act, 'listener', fx.field_answers(fields, '问卷3'))
    fx.transition(base, AT, reg1, 'approved')
    fx.transition(base, AT, reg3, 'approved')

    sv1, qr1 = fx.create_survey(base, AT, act, ver_id, '全员问卷', 'both')
    sv2, qr2 = fx.create_survey(base, AT, act, ver_id, '倾诉者专卷', 'speaker')

    # ---------- 1. 资格四条件逐项 ----------
    s, r = call(base, 'GET', '/api/cc/surveys/%s' % qr1)
    rep.check('SUR-01 未登录访问问卷 → 401', s == 401, r)
    s, r = call(base, 'GET', '/api/cc/surveys/%s' % qr1, token=PT2)
    rep.check('SUR-02 报名未通过 → eligible=false 含 not_approved',
              s == 200 and r.get('eligible') is False and 'not_approved' in (r.get('reasons') or []), r)
    s, r = call(base, 'GET', '/api/cc/surveys/%s' % qr1, token=PT1)
    rep.check('SUR-03 问卷未开放 → eligible=false 含 not_open',
              s == 200 and r.get('eligible') is False and 'not_open' in (r.get('reasons') or []), r)
    s, r = call(base, 'GET', '/api/cc/surveys/%s' % qr2, token=PT3)
    rep.check('SUR-04 角色不匹配（listener 填 speaker 专卷）→ 含 role_mismatch',
              s == 200 and r.get('eligible') is False and 'role_mismatch' in (r.get('reasons') or []), r)

    call(base, 'POST', '/api/cc/activity-surveys/%s/open' % sv1, {}, AT)
    call(base, 'POST', '/api/cc/activity-surveys/%s/open' % sv2, {}, AT)
    s, r = call(base, 'GET', '/api/cc/surveys/%s' % qr1, token=PT1)
    rep.check('SUR-05 四条件齐备 → eligible=true 且题目下发（未签到不影响）',
              s == 200 and r.get('eligible') is True and len(r.get('questions') or []) == 3, r)
    s, r = call(base, 'GET', '/api/cc/surveys/%s' % qr2, token=PT3)
    rep.check('SUR-06 开放后角色不匹配仍拒绝',
              s == 200 and r.get('eligible') is False and 'role_mismatch' in (r.get('reasons') or []), r)

    # 提交侧资格拦截
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % sv2,
                {'answers': [{'question_code': 'MOOD', 'value': 3}, {'question_code': 'SAT', 'value': 'ok'}]}, PT3)
    rep.check('SUR-07 角色不匹配提交 → 403 survey_not_eligible',
              s == 403 and biz_code(r) == 'survey_not_eligible', r)
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % sv1,
                {'answers': [{'question_code': 'MOOD', 'value': 3}, {'question_code': 'SAT', 'value': 'ok'}]}, PT2)
    rep.check('SUR-08 报名未通过提交 → 403 survey_not_eligible',
              s == 403 and biz_code(r) == 'survey_not_eligible', r)

    # ---------- 2. 草稿 → 提交 → 锁定与幂等 ----------
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/draft' % sv1,
                {'answers': [{'question_code': 'SAT', 'value': 'ok'}]}, PT1)
    rep.check('SUR-09 保存草稿（status=draft）',
              s == 200 and (r.get('submission') or {}).get('status') == 'draft', r)
    s, r = call(base, 'GET', '/api/cc/surveys/%s' % qr1, token=PT1)
    ma = r.get('my_answers') or []
    rep.check('SUR-10 草稿后元信息带回 my_submission=draft + my_answers 预填',
              s == 200 and (r.get('my_submission') or {}).get('status') == 'draft'
              and next((a for a in ma if a.get('question_code') == 'SAT'), {}).get('value') == 'ok', r)

    full = [{'question_code': 'MOOD', 'value': 4}, {'question_code': 'SAT', 'value': 'good'},
            {'question_code': 'NOTE', 'value': '原答案'}]
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % sv1, {'answers': full}, PT1)
    SUB = (r.get('submission') or {}).get('id')
    rep.check('SUR-11 草稿→正式提交为同一行状态变更（submitted）',
              s == 200 and bool(SUB) and (r.get('submission') or {}).get('status') == 'submitted', r)
    changed = [{'question_code': 'MOOD', 'value': 1}, {'question_code': 'SAT', 'value': 'ok'},
               {'question_code': 'NOTE', 'value': '篡改答案'}]
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % sv1, {'answers': changed}, PT1)
    rep.check('SUR-12 重复提交幂等（idempotent=true，不产生重复记录）',
              s == 200 and r.get('idempotent') is True
              and (r.get('submission') or {}).get('id') == SUB, r)
    s, r = call(base, 'GET', '/api/cc/submissions/%s' % SUB, token=PT1)
    ans = r.get('answers') or []
    rep.check('SUR-13 幂等返回不改变已提交答案（MOOD 仍为 4）',
              s == 200 and next((a for a in ans if a.get('question_code') == 'MOOD'), {}).get('value') == 4, r)
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/draft' % sv1,
                {'answers': [{'question_code': 'SAT', 'value': 'ok'}]}, PT1)
    rep.check('SUR-14 提交后草稿请求 → 409 submission_locked（提交锁定）',
              s == 409 and biz_code(r) == 'submission_locked', r)

    _, m = call(base, 'GET', '/api/cc/metrics/survey_submissions', token=AT)
    rep.check('SUR-15 看板口径：有效提交答卷 = 1', m.get('value') == 1, m)

    # ---------- 3. 作废（FR-SUR-010）----------
    s, r = call(base, 'POST', '/api/cc/submissions/%s/void' % SUB, {}, AT)
    rep.check('SUR-16 作废缺原因 → 400', s == 400, r)
    s, r = call(base, 'POST', '/api/cc/submissions/%s/void' % SUB, {'reason': '答题无效'}, AT)
    rep.check('SUR-17 管理员作废成功', s == 200 and r.get('status') == 'voided', r)
    s, r = call(base, 'GET',
                f"/api/collections/audit_logs/records?filter=(action='submission.void'%26%26target_id='{SUB}')",
                token=st)
    items = r.get('items') or []
    rep.check('SUR-18 作废写审计（原因 + 前后状态）',
              s == 200 and len(items) == 1 and items[0].get('reason') == '答题无效', items)
    _, m = call(base, 'GET', '/api/cc/metrics/survey_submissions', token=AT)
    rep.check('SUR-19 作废后统计排除（有效提交 = 0）', m.get('value') == 0, m)
    s, r = call(base, 'GET',
                "/api/collections/submissions/records?perPage=10&filter=(activity_survey_id='%s')" % sv1,
                token=AT)
    items = r.get('items') or []
    rep.check('SUR-20 作废记录保留可查（status=voided）',
              s == 200 and len(items) == 1 and items[0].get('status') == 'voided', items)
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % sv1, {'answers': full}, PT1)
    rep.check('SUR-21 作废后不可重填 → 409 submission_voided',
              s == 409 and biz_code(r) == 'submission_voided', r)
