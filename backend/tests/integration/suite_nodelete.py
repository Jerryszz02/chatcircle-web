# -*- coding: utf-8 -*-
"""suite_nodelete — 无硬删除（AC-18、FR-AUD-001、FR-AUD-002）。

断言：全部 24 个可造 fixture 的业务集合 delete 通道对机构管理员与参与者关闭（403/404）；
审计日志对普通管理员无创建/修改途径（FR-AUD-002）。
归档/作废后记录仍可审计查询，由 suite_checkins CHK-18 与 suite_surveys SUR-20 覆盖。
"""
import cc_fixture as fx
from cc_client import call


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    fields, ver_id = ctx['fields'], ctx['ver_id']
    rep.section('suite_nodelete：无硬删除（AC-18）')

    # ---------- fixture：每个集合至少一条真实记录 ----------
    org = fx.create_org(base, st, '删除校验机构')
    _, AT = fx.create_admin(base, st, org, 'ndel_admin_1')
    # 第二管理员仅作 delete 目标记录，无需登录态：超管直建（invite 流程的登录会占用
    # 内置 auth-with-password per-IP 限流预算，见 suite_hardening 头注释）
    s, a2 = call(base, 'POST', '/api/collections/admin_accounts/records',
                 {'username': 'ndel_admin_2', 'password': fx.PASSWORD,
                  'passwordConfirm': fx.PASSWORD, 'organization_id': org, 'status': 'active'}, st)
    assert s == 200, '超管直建第二管理员失败：%s' % a2
    act = fx.create_activity(base, AT, org, 'CC_IT_NDEL_01', '删除校验场',
                             fields=[(fields['nickname'], True, True)])
    P, PT, _ = fx.create_participant(base, 'ndel_user')
    reg = fx.register(base, PT, act, 'speaker', fx.field_answers(fields, '删验'))
    fx.transition(base, AT, reg, 'approved')
    call(base, 'POST', '/api/cc/activities/%s/checkin/open' % act, {}, AT)
    s, ck = fx.self_checkin(base, fx.checkin_token(base, AT, act), PT)
    checkin = (ck.get('checkin') or {}).get('id')
    # T2 activity_pairs：补一名聆听者签到并开始配对，得到真实 pair fixture。
    P2, PT2, _ = fx.create_participant(base, 'ndel_listener')
    reg2 = fx.register(base, PT2, act, 'listener', fx.field_answers(fields, '删验聆听者'))
    fx.transition(base, AT, reg2, 'approved')
    fx.self_checkin(base, fx.checkin_token(base, AT, act), PT2)
    call(base, 'POST', '/api/cc/activities/%s/pairings/start' % act, {}, AT)
    sv, _ = fx.create_survey(base, AT, act, ver_id, '删验问卷')
    call(base, 'POST', '/api/cc/activity-surveys/%s/open' % sv, {}, AT)
    s, sub = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % sv,
                  {'answers': [{'question_code': 'MOOD', 'value': 3},
                               {'question_code': 'SAT', 'value': 'ok'}]}, PT)
    submission = (sub.get('submission') or {}).get('id')
    s, exp = call(base, 'POST', '/api/cc/exports', {'scope': {'type': 'organization'}}, AT)
    job = (exp.get('export_job') or {}).get('id')
    # 仅超管可建的集合经超管通道补齐
    s, inv = call(base, 'POST', '/api/cc/super/invites', {'organization_id': org}, st)
    invite = (inv.get('invite') or {}).get('id')
    s, appr = call(base, 'POST', '/api/collections/activity_approvals/records',
                   {'activity_id': act, 'reviewer_id': ctx['sid'], 'action': 'submit'}, st)
    approval = appr.get('id')
    # 培训体系三集合（guards 拦截非超管直连写，超管通道直建记录即可）
    s, trn = call(base, 'POST', '/api/collections/trainings/records',
                  {'organization_id': org, 'title': '删验培训', 'training_code': 'CC_IT_NDEL_TRN_01',
                   'status': 'draft'}, st)
    assert s == 200, '超管直建培训失败：%s' % trn
    training = trn['id']
    s, tses = call(base, 'POST', '/api/collections/training_checkin_sessions/records',
                   {'training_id': training, 'status': 'open',
                    'opened_at': '2026-08-10 12:00:00Z', 'opened_by': ctx['sid']}, st)
    assert s == 200, '超管直建培训场次失败：%s' % tses
    tsession = tses['id']
    s, tat = call(base, 'POST', '/api/collections/training_attendances/records',
                  {'training_id': training, 'participant_id': P, 'source': 'manual',
                   'status': 'valid', 'checked_in_at': '2026-08-10 12:30:00Z'}, st)
    assert s == 200, '超管直建培训签到失败：%s' % tat
    tattendance = tat['id']
    # posts 内容推文（2026-08 改版；仅超管可写，超管通道直建）
    s, po = call(base, 'POST', '/api/collections/posts/records',
                 {'title': '删验推文', 'body_md': 'x', 'status': 'hidden'}, st)
    assert s == 200, '超管直建推文失败：%s' % po
    post = po['id']

    def sid(coll, flt):
        _, r = call(base, 'GET', '/api/collections/%s/records?perPage=1&filter=(%s)' % (coll, flt), token=st)
        items = r.get('items') or []
        return items[0]['id'] if items else None

    admin2 = sid('admin_accounts', "username='ndel_admin_2'")
    reg_ans = sid('registration_answers', "registration_id='%s'" % reg)
    session = sid('checkin_sessions', "activity_id='%s'" % act)
    question = sid('survey_questions', "activity_survey_id='%s'" % sv)
    answer = sid('answers', "submission_id='%s'" % submission)
    audit = sid('audit_logs', "organization_id='%s'" % org)
    activity_pair = sid('activity_pairs', "activity_id='%s'" % act)

    targets = [
        ('organizations', org), ('admin_invites', invite), ('admin_accounts', admin2),
        ('participant_accounts', P), ('activities', act), ('activity_approvals', approval),
        ('registration_field_defs', fields['nickname']), ('registrations', reg),
        ('registration_answers', reg_ans), ('checkin_sessions', session),
        ('checkins', checkin), ('activity_pairs', activity_pair),
        ('survey_templates', ctx['tpl_id']),
        ('survey_template_versions', ver_id), ('activity_surveys', sv),
        ('survey_questions', question), ('submissions', submission),
        ('answers', answer), ('export_jobs', job), ('audit_logs', audit),
        ('trainings', training), ('training_checkin_sessions', tsession),
        ('training_attendances', tattendance), ('posts', post),
    ]
    rep.check('NDEL-00 fixture：24 个集合均有真实记录', all(t[1] for t in targets),
              [t for t in targets if not t[1]])

    # ---------- 1. 机构管理员 delete 全部业务集合被拒 ----------
    for i, (coll, rid) in enumerate(targets, 1):
        s, r = call(base, 'DELETE', '/api/collections/%s/records/%s' % (coll, rid), token=AT)
        rep.check('NDEL-%02d 管理员 delete %s → 403/404' % (i, coll),
                  s in (403, 404), 'status=%s body=%s' % (s, r))

    # ---------- 2. 参与者 delete 被拒 ----------
    s, r = call(base, 'DELETE', '/api/collections/registrations/records/%s' % reg, token=PT)
    rep.check('NDEL-25 参与者 delete 本人报名 → 403/404', s in (403, 404), r)
    s, r = call(base, 'DELETE', '/api/collections/participant_accounts/records/%s' % P, token=PT)
    rep.check('NDEL-26 参与者 delete 本人账号 → 403/404', s in (403, 404), r)

    # ---------- 3. 审计日志无创建/修改途径（FR-AUD-002）----------
    s, r = call(base, 'POST', '/api/collections/audit_logs/records',
                {'actor_id': 'x', 'actor_role': 'admin', 'organization_id': org,
                 'action': 'test.probe', 'target_type': 'x', 'target_id': 'y',
                 'result': 'success'}, AT)
    rep.check('NDEL-27 管理员 create audit_logs → 403/404', s in (403, 404), r)
    s, r = call(base, 'PATCH', '/api/collections/audit_logs/records/%s' % audit,
                {'action': 'tampered'}, AT)
    rep.check('NDEL-28 管理员 update audit_logs → 403/404', s in (403, 404), r)
