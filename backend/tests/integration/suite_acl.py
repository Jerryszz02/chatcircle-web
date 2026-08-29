# -*- coding: utf-8 -*-
"""suite_acl — 越权访问自动化套件（AC-03，test-plan §4，CI 必过核心套件）。

攻击向量：机构 A 管理员凭据 → 机构 B 资源的直接 ID、列表筛选、自定义端点、
导出 scope_json 伪造 organization_id、看板下钻参数；
横向：普通管理员 → 超管端点；参与者凭据 → 管理端点与他人记录；未认证 → 业务接口。

断言原则：返回 403/404/401 且响应体不含机构 B 数据；伪造的机构参数被服务端忽略
（PRD §12.2：机构范围一律从登录身份注入）。

强制扩展规则（test-plan §4）：新增任何携带或可反查 organization_id 的接口，
必须同 PR 在本套件补充越权用例。
"""
import csv
import io
import zipfile

import cc_fixture as fx
from cc_client import biz_code, call


def _ids(body):
    return [r.get('id') for r in (body.get('items') or [])]


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    fields, ver_id = ctx['fields'], ctx['ver_id']
    rep.section('suite_acl：越权矩阵（AC-03）')

    # ---------- fixture：机构 A / B 双侧全量业务数据 ----------
    org_a = fx.create_org(base, st, '越权机构A', allow_sensitive=True)
    org_b = fx.create_org(base, st, '越权机构B')
    _, AT_A = fx.create_admin(base, st, org_a, 'acl_admin_a')
    _, AT_B = fx.create_admin(base, st, org_b, 'acl_admin_b')

    act_a = fx.create_activity(base, AT_A, org_a, 'CC_IT_ACL_A1', '机构A活动',
                               fields=fx.nick_field_cfg(fields))
    act_b_pub = fx.create_activity(base, AT_B, org_b, 'CC_IT_ACL_B1', '机构B已发布活动',
                                   fields=[(fields['nickname'], True, True),
                                           (fields['phone'], True, False)])
    act_b_draft = fx.create_activity(base, AT_B, org_b, 'CC_IT_ACL_B2', '机构B草稿活动',
                                     fields=fx.nick_field_cfg(fields), publish=False)

    P_A, PT_A, _ = fx.create_participant(base, 'acl_user_a')
    reg_a = fx.register(base, PT_A, act_a, 'speaker', fx.field_answers(fields, '越权甲'))
    fx.transition(base, AT_A, reg_a, 'approved')

    P_B, PT_B, _ = fx.create_participant(base, 'acl_user_b')
    reg_b = fx.register(base, PT_B, act_b_pub, 'speaker',
                        fx.field_answers(fields, '越权乙', phone='13800000000'))
    fx.transition(base, AT_B, reg_b, 'approved')
    call(base, 'POST', '/api/cc/activities/%s/checkin/open' % act_b_pub, {}, AT_B)
    s, ckb = fx.self_checkin(base, fx.checkin_token(base, AT_B, act_b_pub), PT_B)
    checkin_b = (ckb.get('checkin') or {}).get('id')
    call(base, 'POST', '/api/cc/activities/%s/checkin/close' % act_b_pub, {}, AT_B)
    P_B2, PT_B2, _ = fx.create_participant(base, 'acl_user_b_listener')
    reg_b2 = fx.register(base, PT_B2, act_b_pub, 'listener',
                         fx.field_answers(fields, '越权乙听', phone='13800000001'))
    fx.transition(base, AT_B, reg_b2, 'approved')
    s, manual_b2 = call(base, 'POST', '/api/cc/checkins/manual',
                        {'activity_id': act_b_pub, 'participant_id': P_B2,
                         'reason': 'ACL 配对 fixture'}, AT_B)
    checkin_b2 = (manual_b2.get('checkin') or {}).get('id')
    s, pairing_b = call(base, 'POST', '/api/cc/activities/%s/pairings/start' % act_b_pub,
                        {}, AT_B)
    s, pairs_b = call(
        base, 'GET',
        "/api/collections/activity_pairs/records?perPage=1&filter=(activity_id='%s')" % act_b_pub,
        token=st,
    )
    pair_b = ((pairs_b.get('items') or [{}])[0]).get('id')
    sv_b, qr_b = fx.create_survey(base, AT_B, act_b_pub, ver_id, '机构B问卷')
    call(base, 'POST', '/api/cc/activity-surveys/%s/open' % sv_b, {}, AT_B)
    s, subb = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % sv_b,
                   {'answers': [{'question_code': 'MOOD', 'value': 5},
                                {'question_code': 'SAT', 'value': 'ok'}]}, PT_B)
    sub_b = (subb.get('submission') or {}).get('id')
    s, expb = call(base, 'POST', '/api/cc/exports',
                   {'scope': {'type': 'organization'}, 'include_pii': False}, AT_B)
    job_b = (expb.get('export_job') or {}).get('id')
    # 机构B自定义报名字段（A 不可见）；未使用邀请码（revoke 攻击向量）
    s, fdb = call(base, 'POST', '/api/collections/registration_field_defs/records',
                  {'organization_id': org_b, 'field_code': 'b_custom', 'field_type': 'text',
                   'label': '机构B自定义', 'source_type': 'custom', 'is_sensitive': False,
                   'options_json': None, 'required_default': False, 'status': 'active'}, AT_B)
    field_b = fdb.get('id')
    s, invb = call(base, 'POST', '/api/cc/super/invites', {'organization_id': org_b}, st)
    invite_b = (invb.get('invite') or {}).get('id')

    # 机构B培训 + 签到数据（培训域越权攻击目标）：培训签到前置为 approved 聆听者报名，
    # P_B 在 act_b_pub 已是 speaker（每活动每人一条报名），故另开资格场注册 listener
    act_b_lis = fx.create_activity(base, AT_B, org_b, 'CC_IT_ACL_B3', '机构B聆听者资格场',
                                   fields=fx.nick_field_cfg(fields))
    reg_b_lis = fx.register(base, PT_B, act_b_lis, 'listener', fx.field_answers(fields, '越权乙听'))
    fx.transition(base, AT_B, reg_b_lis, 'approved')
    s, trnb = fx.create_training(base, AT_B, org_b, 'CC_IT_ACL_TRN_B1', '机构B培训')
    training_b = trnb.get('id')
    call(base, 'POST', '/api/cc/trainings/%s/publish' % training_b, {}, AT_B)
    call(base, 'POST', '/api/cc/trainings/%s/checkin/open' % training_b, {}, AT_B)
    s, tckb = fx.self_training_checkin(base, fx.training_token(base, AT_B, training_b), PT_B)
    attendance_b = (tckb.get('attendance') or {}).get('id')

    # 超管视角取机构B各二级表记录 id（供详情越权断言）
    def sid(coll, flt):
        _, r = call(base, 'GET', '/api/collections/%s/records?perPage=1&filter=(%s)' % (coll, flt), token=st)
        items = r.get('items') or []
        return items[0]['id'] if items else None

    reg_ans_b = sid('registration_answers', "registration_id='%s'" % reg_b)
    session_b = sid('checkin_sessions', "activity_id='%s'" % act_b_pub)
    tsession_b = sid('training_checkin_sessions', "training_id='%s'" % training_b)
    question_b = sid('survey_questions', "activity_survey_id='%s'" % sv_b)
    answer_b = sid('answers', "submission_id='%s'" % sub_b)
    audit_b = sid('audit_logs', "organization_id='%s'" % org_b)
    fixture_ok = all([reg_b, reg_b2, checkin_b, checkin_b2, pair_b,
                      sv_b, sub_b, job_b, field_b, invite_b,
                      reg_ans_b, session_b, question_b, answer_b, audit_b,
                      training_b, attendance_b, tsession_b])
    rep.check('fixture 双侧数据齐备（B 侧报名/签到/配对/问卷/答卷/导出/审计/自定义字段/邀请码/培训/培训签到）',
              fixture_ok)
    if not fixture_ok:
        return

    # ---------- 1. 列表与详情：admin A → 机构 B 集合 ----------
    s, r = call(base, 'GET', '/api/collections/activities/records?perPage=100', token=AT_A)
    rep.check('ACL-01 活动列表仅本机构（不含机构B任何活动，响应体无 B 数据）',
              s == 200 and act_b_pub not in _ids(r) and act_b_draft not in _ids(r)
              and act_a in _ids(r), _ids(r))
    s, r = call(base, 'GET', '/api/collections/activities/records/%s' % act_b_draft, token=AT_A)
    rep.check('ACL-02 详情：机构B草稿活动 → 404', s == 404, r)

    def deny(coll, rid, label, codes=(403, 404)):
        s2, r2 = call(base, 'GET', '/api/collections/%s/records/%s' % (coll, rid), token=AT_A)
        rep.check(label, s2 in codes, 'status=%s body=%s' % (s2, r2))

    def list_clean(coll, flt_ids, label):
        s2, r2 = call(base, 'GET', '/api/collections/%s/records?perPage=100' % coll, token=AT_A)
        got = _ids(r2)
        rep.check(label, s2 == 200 and all(i not in got for i in flt_ids), got)

    list_clean('registrations', [reg_b], 'ACL-03 报名列表不含机构B报名')
    deny('registrations', reg_b, 'ACL-04 详情：机构B报名 → 404')
    list_clean('registration_answers', [reg_ans_b], 'ACL-05 报名答案列表不含机构B答案')
    deny('registration_answers', reg_ans_b, 'ACL-06 详情：机构B报名答案 → 404')
    list_clean('checkins', [checkin_b], 'ACL-07 签到列表不含机构B签到')
    deny('checkins', checkin_b, 'ACL-08 详情：机构B签到 → 404')
    list_clean('activity_pairs', [pair_b], 'ACL-T2-01 配对列表不含机构B配对')
    deny('activity_pairs', pair_b, 'ACL-T2-02 详情：机构B配对 → 404')
    list_clean('checkin_sessions', [session_b], 'ACL-09 签到场次列表不含机构B场次')
    deny('checkin_sessions', session_b, 'ACL-10 详情：机构B签到场次 → 404')
    list_clean('activity_surveys', [sv_b], 'ACL-11 问卷列表不含机构B问卷')
    deny('activity_surveys', sv_b, 'ACL-12 详情：机构B问卷 → 404')
    list_clean('survey_questions', [question_b], 'ACL-13 题目列表不含机构B题目')
    deny('survey_questions', question_b, 'ACL-14 详情：机构B题目 → 404')
    list_clean('submissions', [sub_b], 'ACL-15 答卷列表不含机构B答卷')
    deny('submissions', sub_b, 'ACL-16 详情：机构B答卷 → 404')
    list_clean('answers', [answer_b], 'ACL-17 答案列表不含机构B答案')
    deny('answers', answer_b, 'ACL-18 详情：机构B答案 → 404')
    list_clean('export_jobs', [job_b], 'ACL-19 导出任务列表不含机构B任务')
    deny('export_jobs', job_b, 'ACL-20 详情：机构B导出任务 → 404')
    s, r = call(base, 'GET', '/api/collections/audit_logs/records?perPage=100', token=AT_A)
    rep.check('ACL-21 审计列表仅本机构（不含机构B审计）',
              s == 200 and audit_b not in _ids(r), _ids(r))
    deny('audit_logs', audit_b, 'ACL-22 详情：机构B审计 → 404')
    s, r = call(base, 'GET', '/api/collections/organizations/records?perPage=100', token=AT_A)
    rep.check('ACL-23 机构列表仅本机构', s == 200 and _ids(r) == [org_a], _ids(r))
    deny('organizations', org_b, 'ACL-24 详情：机构B机构 → 404')
    s, r = call(base, 'GET', '/api/collections/admin_accounts/records?perPage=100', token=AT_A)
    rep.check('ACL-25 管理员列表仅本机构同事',
              s == 200 and all((it.get('organization_id') == org_a) for it in r.get('items', [])),
              r.get('items'))
    deny('registration_field_defs', field_b, 'ACL-26 详情：机构B自定义字段 → 404')
    s, r = call(base, 'GET', '/api/collections/activity_approvals/records?perPage=100', token=AT_A)
    rep.check('ACL-27 活动审批记录列表不含机构B记录',
              s == 200 and all((it.get('activity_id') not in (act_b_pub, act_b_draft))
                               for it in r.get('items', [])), r.get('items'))
    s, r = call(base, 'GET', '/api/collections/admin_invites/records', token=AT_A)
    rep.check('ACL-28 邀请码列表对普通管理员关闭（401/403）', s in (401, 403), r)

    # ---------- 2. 自定义业务端点：admin A → 机构 B 资源 ----------
    def deny_post(path, body, label, codes=(403, 404)):
        s2, r2 = call(base, 'POST', path, body, AT_A)
        rep.check(label, s2 in codes, 'status=%s body=%s' % (s2, r2))

    deny_post('/api/cc/registrations/%s/transition' % reg_b, {'to': 'rejected'},
              'ACL-29 审核机构B报名 → 404')
    deny_post('/api/cc/activities/%s/publish' % act_b_draft, {},
              'ACL-30 发布机构B活动 → 404')
    deny_post('/api/cc/activities/%s/submit-review' % act_b_draft, {},
              'ACL-31 提交机构B活动审核 → 404')
    deny_post('/api/cc/activities/%s/close' % act_b_pub, {}, 'ACL-32 关闭机构B活动 → 404')
    deny_post('/api/cc/activities/%s/archive' % act_b_pub, {}, 'ACL-33 归档机构B活动 → 404')
    deny_post('/api/cc/activities/%s/checkin/open' % act_b_pub, {},
              'ACL-34 开放机构B签到 → 404')
    deny_post('/api/cc/activities/%s/checkin/close' % act_b_pub, {},
              'ACL-35 关闭机构B签到 → 404')
    deny_post('/api/cc/checkins/manual',
              {'activity_id': act_b_pub, 'participant_id': P_B, 'reason': '越权补签'},
              'ACL-36 对机构B活动补签 → 404')
    deny_post('/api/cc/checkins/%s/revoke' % checkin_b, {'reason': '越权撤销'},
              'ACL-37 撤销机构B签到 → 404')
    deny_post('/api/cc/activities/%s/surveys' % act_b_pub,
              {'template_version_id': ver_id, 'title': '越权问卷', 'role_scope': 'both'},
              'ACL-38 在机构B活动下建问卷 → 403')
    deny_post('/api/cc/activity-surveys/%s/open' % sv_b, {}, 'ACL-39 开放机构B问卷 → 403')
    deny_post('/api/cc/activity-surveys/%s/close' % sv_b, {}, 'ACL-40 结束机构B问卷 → 403')
    deny_post('/api/cc/submissions/%s/void' % sub_b, {'reason': '越权作废'},
              'ACL-41 作废机构B答卷 → 403')

    # ---------- 3. 导出与看板：伪造机构参数被忽略/拒绝 ----------
    s, r = call(base, 'POST', '/api/cc/exports',
                {'scope': {'type': 'activity', 'activity_id': act_b_pub}, 'include_pii': False}, AT_A)
    rep.check('ACL-42 导出 scope 指定机构B活动 → 403 scope_forbidden',
              s == 403 and biz_code(r) == 'scope_forbidden', r)
    s, r = call(base, 'GET', '/api/cc/exports/%s/download' % job_b, token=AT_A)
    rep.check('ACL-43 下载机构B导出文件 → 403', s == 403, r)
    s, r = call(base, 'POST', '/api/cc/exports',
                {'scope': {'type': 'organization', 'organization_id': org_b}, 'include_pii': False}, AT_A)
    job_forge = (r.get('export_job') or {})
    rep.check('ACL-44 scope_json 伪造机构B：任务范围被服务端改写为本机构',
              s == 200 and (job_forge.get('scope') or {}).get('organization_id') == org_a, r)
    if job_forge.get('id'):
        s, blob = call(base, 'GET', '/api/cc/exports/%s/download' % job_forge['id'], token=AT_A, raw=True)
        leaked = True
        if s == 200 and isinstance(blob, bytes):
            zf = zipfile.ZipFile(io.BytesIO(blob))
            content = zf.read('activities.csv').decode('utf-8-sig')
            rows = list(csv.reader(io.StringIO(content)))
            leaked = any(len(row) > 1 and row[1] == org_b for row in rows[1:] if row)
        rep.check('ACL-45 伪造范围导出 ZIP 内不含机构B活动行', s == 200 and not leaked,
                  'status=%s' % s)
    s, r = call(base, 'GET', '/api/cc/metrics/applications?organization_id=%s' % org_b, token=AT_A)
    rep.check('ACL-46 看板伪造 organization_id 被忽略（恒为本机构，值=1）',
              s == 200 and (r.get('filters') or {}).get('organization_id') == org_a
              and r.get('value') == 1, r)

    # ---------- 4. 横向：普通管理员 → 超管端点 ----------
    deny_post('/api/cc/super/invites', {'organization_id': org_a},
              'ACL-47 管理员生成邀请码 → 403', codes=(401, 403))
    deny_post('/api/cc/super/invites/%s/revoke' % invite_b, {},
              'ACL-48 管理员撤销邀请码 → 403', codes=(401, 403))
    s, r = call(base, 'GET', '/api/cc/super/backup-status', token=AT_A)
    rep.check('ACL-49 管理员读备份状态 → 403', s in (401, 403), r)
    deny_post('/api/cc/super/backup/run', {}, 'ACL-50 管理员触发备份 → 403', codes=(401, 403))
    deny_post('/api/cc/activities/%s/approve' % act_b_pub, {},
              'ACL-51 管理员批准活动（超管端点）→ 403', codes=(401, 403))
    deny_post('/api/cc/activities/%s/reject' % act_b_pub, {'reason': 'x'},
              'ACL-52 管理员驳回活动（超管端点）→ 403', codes=(401, 403))
    deny_post('/api/cc/activities/%s/unpublish' % act_b_pub, {'reason': 'x'},
              'ACL-53 管理员下架活动（超管端点）→ 403', codes=(401, 403))

    # ---------- 5. 参与者越权：管理端点与他人记录 ----------
    s, r = call(base, 'POST', '/api/cc/registrations/%s/transition' % reg_a, {'to': 'approved'}, PT_A)
    rep.check('ACL-54 参与者审核报名 → 403', s in (401, 403), r)
    s, r = call(base, 'POST', '/api/cc/checkins/manual',
                {'activity_id': act_a, 'participant_id': P_A, 'reason': 'x'}, PT_A)
    rep.check('ACL-55 参与者补签 → 403', s in (401, 403), r)
    s, r = call(base, 'POST', '/api/cc/exports', {'scope': {'type': 'organization'}}, PT_A)
    rep.check('ACL-56 参与者创建导出 → 401', s in (401, 403), r)
    s, r = call(base, 'GET', '/api/cc/metrics/applications', token=PT_A)
    rep.check('ACL-57 参与者调用看板 → 401', s in (401, 403), r)
    s, r = call(base, 'GET', '/api/cc/super/backup-status', token=PT_A)
    rep.check('ACL-58 参与者读备份状态 → 403', s in (401, 403), r)
    s, r = call(base, 'POST', '/api/cc/submissions/%s/void' % sub_b, {'reason': 'x'}, PT_A)
    rep.check('ACL-59 参与者作废答卷 → 401/403', s in (401, 403), r)
    s, r = call(base, 'GET', '/api/collections/registrations/records?perPage=100', token=PT_A)
    rep.check('ACL-60 参与者报名列表仅本人（=1）', s == 200 and _ids(r) == [reg_a], _ids(r))
    s, r = call(base, 'GET', '/api/collections/registrations/records/%s' % reg_b, token=PT_A)
    rep.check('ACL-61 参与者读他人报名 → 404', s == 404, r)
    s, r = call(base, 'GET', '/api/cc/submissions/%s' % sub_b, token=PT_A)
    rep.check('ACL-62 参与者读他人答卷（自定义端点）→ 403', s == 403, r)
    s, r = call(base, 'GET', '/api/collections/submissions/records/%s' % sub_b, token=PT_A)
    rep.check('ACL-63 参与者读他人答卷（集合 API）→ 404', s == 404, r)

    # ---------- 6. 未认证 ----------
    s, r = call(base, 'GET', '/api/collections/registrations/records')
    rep.check('ACL-64 未认证报名列表为空集（无泄露）',
              s == 200 and r.get('totalItems') == 0, r)
    s, r = call(base, 'GET', '/api/collections/activities/records/%s' % act_b_pub)
    rep.check('ACL-65 未认证原生 view 已发布活动 → 404（公开详情只走 /api/cc/public/activities 白名单端点）',
              s == 404, r)
    s, r = call(base, 'GET', '/api/collections/activities/records/%s' % act_b_draft)
    rep.check('ACL-66 未认证看草稿活动 → 404', s == 404, r)
    s, r = call(base, 'GET', '/api/cc/metrics/applications')
    rep.check('ACL-67 未认证调用看板 → 401', s == 401, r)

    # ---------- 7. 补签候选人名单（含用户名，按机构隔离） ----------
    s, r = call(base, 'GET', '/api/cc/activities/%s/checkin/manual-candidates' % act_b_pub, token=AT_A)
    rep.check('ACL-68 机构A管理员读机构B补签候选人 → 404', s == 404, r)
    s, r = call(base, 'GET', '/api/cc/activities/%s/checkin/manual-candidates' % act_a, token=PT_A)
    rep.check('ACL-69 参与者读补签候选人 → 401/403', s in (401, 403), r)
    s, r = call(base, 'GET', '/api/cc/activities/%s/checkin/manual-candidates' % act_b_pub)
    rep.check('ACL-70 未认证读补签候选人 → 401', s == 401, r)

    # ---------- 8. 培训体系（trainings / training_attendances / training_checkin_sessions） ----------
    list_clean('trainings', [training_b], 'ACL-71 培训列表不含机构B培训')
    deny('trainings', training_b, 'ACL-72 详情：机构B培训 → 404')
    list_clean('training_attendances', [attendance_b], 'ACL-73 培训签到列表不含机构B记录')
    deny('training_attendances', attendance_b, 'ACL-74 详情：机构B培训签到 → 404')
    list_clean('training_checkin_sessions', [tsession_b], 'ACL-75 培训签到场次列表不含机构B场次')
    deny('training_checkin_sessions', tsession_b, 'ACL-76 详情：机构B培训签到场次 → 404')
    deny_post('/api/cc/trainings/%s/publish' % training_b, {}, 'ACL-77 发布机构B培训 → 404')
    deny_post('/api/cc/trainings/%s/close' % training_b, {}, 'ACL-78 关闭机构B培训 → 404')
    deny_post('/api/cc/trainings/%s/checkin/open' % training_b, {},
              'ACL-79 开放机构B培训签到 → 404')
    deny_post('/api/cc/trainings/%s/checkin/close' % training_b, {},
              'ACL-80 关闭机构B培训签到 → 404')
    deny_post('/api/cc/training-checkins/manual',
              {'training_id': training_b, 'participant_id': P_B, 'reason': '越权补签'},
              'ACL-81 对机构B培训补签 → 404')
    deny_post('/api/cc/training-checkins/%s/revoke' % attendance_b, {'reason': '越权撤销'},
              'ACL-82 撤销机构B培训签到 → 404')
    s, r = call(base, 'GET', '/api/cc/trainings/%s/checkin/manual-candidates' % training_b, token=AT_A)
    rep.check('ACL-83 机构A管理员读机构B培训补签候选人 → 404', s == 404, r)
    s, r = call(base, 'POST', '/api/cc/trainings/%s/publish' % training_b, {}, PT_A)
    rep.check('ACL-84 参与者发布培训 → 401/403', s in (401, 403), r)
    s, r = call(base, 'GET', '/api/cc/trainings/%s/checkin/manual-candidates' % training_b, token=PT_A)
    rep.check('ACL-85 参与者读培训补签候选人 → 401/403', s in (401, 403), r)
    s, r = call(base, 'POST', '/api/cc/training-checkin/self', {'token': 'x'})
    rep.check('ACL-86 未认证培训自助签到 → 401', s == 401, r)

    # ---------- 9. 内容推文 posts（2026-08 改版：仅超管写，公开仅见 visible，无机构维度） ----------
    s, r = call(base, 'POST', '/api/collections/posts/records',
                {'title': 'ACL可见推文', 'body_md': 'x', 'status': 'visible'}, st)
    assert s == 200, '超管建可见推文失败：%s' % r
    post_visible = r['id']
    s, r = call(base, 'POST', '/api/collections/posts/records',
                {'title': 'ACL隐藏推文', 'body_md': 'x', 'status': 'hidden'}, st)
    assert s == 200, '超管建隐藏推文失败：%s' % r
    post_hidden = r['id']
    s, r = call(base, 'POST', '/api/collections/posts/records',
                {'title': '越权推文', 'body_md': 'x'}, AT_A)
    rep.check('ACL-87 机构管理员建推文 → 400/403/404', s in (400, 403, 404), r)
    s, r = call(base, 'PATCH', '/api/collections/posts/records/%s' % post_visible,
                {'title': '篡改'}, AT_A)
    rep.check('ACL-88 机构管理员改推文 → 400/403/404', s in (400, 403, 404), r)
    s, r = call(base, 'DELETE', '/api/collections/posts/records/%s' % post_visible, token=AT_A)
    rep.check('ACL-89 机构管理员删推文 → 400/403/404', s in (400, 403, 404), r)
    s, r = call(base, 'POST', '/api/collections/posts/records',
                {'title': '越权推文', 'body_md': 'x'}, PT_A)
    rep.check('ACL-90 参与者建推文 → 400/403/404', s in (400, 403, 404), r)
    s, r = call(base, 'GET', '/api/collections/posts/records?perPage=100')
    ids = _ids(r)
    rep.check('ACL-91 未认证 list 推文仅见 visible（hidden 不下发）',
              s == 200 and post_visible in ids and post_hidden not in ids, r)
    s, r = call(base, 'GET', '/api/collections/posts/records/%s' % post_hidden)
    rep.check('ACL-92 未认证看隐藏推文 → 404', s == 404, r)
