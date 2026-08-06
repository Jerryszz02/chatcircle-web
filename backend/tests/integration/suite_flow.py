# -*- coding: utf-8 -*-
"""suite_flow — 主链路全链路断言（自 /tmp/cc_e2e.py 联调脚本沉淀为正式产物）。

覆盖：邀请码 → 管理员注册/登录 → 建活动（数组版 form_config）→ 发布 →
参与者自动注册 → 公开详情 → 报名 → 审核 → 签到（错误分支 + 幂等）→
问卷（资格/草稿/提交幂等/只读答案/me 聚合）→ 看板指标口径 → 导出 ZIP →
手动备份与故障注入告警 → 未认证错误形态。

对应 AC：AC-02/04/05/06/09/11/12/14/15/16/20/23 的happy path 与关键分支；
专项反例（越权、并发、矩阵枚举、限流等）在各自套件。
"""
import cc_fixture as fx
from cc_client import biz_code, call


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    fields, ver_id = ctx['fields'], ctx['ver_id']
    rep.section('suite_flow：主链路全链路')

    # ---------- A. fixture：两机构 + 标准字段 + 模板 ----------
    org_a = fx.create_org(base, st, '联调机构A·阿尔法', allow_sensitive=True)
    org_b = fx.create_org(base, st, '联调机构B·贝塔')
    rep.check('A1 两机构创建且 id 不同', org_a and org_b and org_a != org_b)
    rep.check('A2 标准字段齐备（nickname/phone/age/channel）',
              all(fields.get(c) for c in ('nickname', 'phone', 'age', 'channel')), fields)
    rep.check('A3 模板+版本（SQL 预注入）可经 API 读取', bool(ctx['tpl_id']) and bool(ver_id))

    # ---------- B. 邀请码 → 管理员注册/登录 ----------
    s, inv = call(base, 'POST', '/api/cc/super/invites', {'organization_id': org_a}, st)
    invite_token = (inv.get('invite') or {}).get('token')
    rep.check('B1 邀请码响应形态 {invite:{token}}', s == 200 and bool(invite_token),
              inv if s != 200 else '')
    s, reg = call(base, 'POST', '/api/cc/auth/admin-register',
                  {'invite_code': invite_token, 'username': 'FlowAdmin', 'password': fx.PASSWORD})
    rep.check('B2 admin-register 成功且用户名小写归一',
              s == 200 and reg.get('record', {}).get('username') == 'flowadmin',
              reg if s != 200 else '')
    _, aauth = call(base, 'POST', '/api/collections/admin_accounts/auth-with-password',
                    {'identity': 'flowadmin', 'password': fx.PASSWORD})
    AT = aauth.get('token')
    rep.check('B3 管理员登录（小写用户名）', bool(AT), aauth)

    # ---------- C. 活动：创建（channel 停用）→ 发布 ----------
    s, act = call(base, 'POST', '/api/collections/activities/records', {
        'organization_id': org_a, 'activity_code': 'CC_IT_FLOW_01', 'title': '八月倾诉茶话会',
        'description': '测试活动', 'location': '线上',
        'start_time': '2026-08-10 12:00:00Z', 'end_time': '2026-08-10 14:00:00Z',
        'status': 'draft', 'capacity_total': 10, 'capacity_speaker': 5, 'capacity_listener': 5,
        'registration_open': True,
        'registration_start_at': '2026-08-01 00:00:00Z', 'registration_end_at': '2026-12-31 23:59:59Z',
        'checkin_qr_token': 'ckqr_cc_it_flow_01', 'group_tag': '',
        'form_config_json': {'fields': [
            {'field_def_id': fields['nickname'], 'enabled': True, 'required': True},
            {'field_def_id': fields['age'], 'enabled': True, 'required': False},
            {'field_def_id': fields['phone'], 'enabled': False, 'required': False},
            {'field_def_id': fields['channel'], 'enabled': False, 'required': False}]},
    }, AT)
    AID = act.get('id')
    rep.check('C1 管理员创建活动（数组版 form_config）', s == 200 and bool(AID),
              act if s != 200 else '')
    s, pub = call(base, 'POST', '/api/cc/activities/%s/publish' % AID, {}, AT)
    rep.check('C2 直接发布活动', s == 200 and pub.get('activity', {}).get('status') == 'published',
              pub if s != 200 else '')

    # ---------- D. 参与者链路 ----------
    s, p1 = call(base, 'POST', '/api/cc/auth/participant',
                 {'username': 'FlowUser_One', 'password': fx.PASSWORD})
    P1T, P1 = p1.get('token'), p1.get('record', {}).get('id')
    rep.check('D1 参与者自动注册（用户名小写归一 + created=true）',
              s == 200 and p1.get('created') is True
              and p1.get('record', {}).get('username') == 'flowuser_one',
              p1 if s != 200 else '')
    _, p2 = call(base, 'POST', '/api/cc/auth/participant',
                 {'username': 'flowuser_two', 'password': fx.PASSWORD})
    P2T = p2.get('token')

    s, det = call(base, 'GET', '/api/cc/public/activities/%s' % AID)
    rf = det.get('registration_fields') or []
    codes = sorted(f.get('field_code') for f in rf)
    rep.check('D2 公开详情 registration_fields（channel 停用后剩 age/nickname）',
              s == 200 and codes == ['age', 'nickname'], det if s != 200 else codes)
    nick = next((f for f in rf if f.get('field_code') == 'nickname'), {})
    rep.check('D3 registration.open/reason + 字段形态（id/source_type/is_sensitive/required）',
              det.get('registration', {}).get('open') is True
              and det.get('registration', {}).get('reason') is None
              and nick.get('required') is True and nick.get('source_type') == 'standard'
              and nick.get('is_sensitive') is False and bool(nick.get('id')))

    # 首页活动广场：公开活动列表（未登录可看，仅 published/closed）
    s, lst = call(base, 'GET', '/api/cc/public/activities')
    items = lst.get('activities') or []
    mine = next((a for a in items if a.get('id') == AID), None)
    rep.check('D3b 公开列表含已发布活动且报名口径与详情一致',
              s == 200 and bool(mine)
              and mine.get('registration', {}).get('open') is True
              and mine.get('registration', {}).get('remaining_total') == 10
              and mine.get('title') == '八月倾诉茶话会',
              lst if s != 200 else mine)

    s, r1 = call(base, 'POST', '/api/cc/activities/%s/register' % AID,
                 {'activity_role': 'speaker',
                  'answers': [{'field_def_id': fields['nickname'], 'value': '阿一'}]}, P1T)
    R1 = (r1.get('registration') or {}).get('id')
    rep.check('D4 报名提交成功', s == 200 and bool(R1), r1 if s != 200 else '')
    s, r2 = call(base, 'POST', '/api/cc/activities/%s/register' % AID,
                 {'activity_role': 'listener',
                  'answers': [{'field_def_id': fields['nickname'], 'value': '阿二'}]}, P2T)
    R2 = (r2.get('registration') or {}).get('id')

    # D5 签到错误分支：报名未审核
    s, e1 = call(base, 'POST', '/api/cc/checkin/%s/self' % AID, {}, P2T)
    rep.check('D5 未审核签到 → 403 registration_not_approved',
              s == 403 and biz_code(e1) == 'registration_not_approved', e1)

    s, tr1 = call(base, 'POST', '/api/cc/registrations/%s/transition' % R1, {'to': 'approved'}, AT)
    rep.check('D6a 管理员审核通过 R1',
              s == 200 and tr1.get('registration', {}).get('status') == 'approved',
              tr1 if s != 200 else '')
    s, tr2 = call(base, 'POST', '/api/cc/registrations/%s/transition' % R2, {'to': 'approved'}, AT)
    rep.check('D6b 管理员审核通过 R2', s == 200, tr2 if s != 200 else '')
    s, e2 = call(base, 'POST', '/api/cc/checkin/%s/self' % AID, {}, P1T)
    rep.check('D6c 签到未开放 → 400 checkin_not_open', s == 400 and biz_code(e2) == 'checkin_not_open', e2)

    s, oc = call(base, 'POST', '/api/cc/activities/%s/checkin/open' % AID, {}, AT)
    rep.check('D7a 开放签到', s == 200, oc if s != 200 else '')
    s, ck = call(base, 'POST', '/api/cc/checkin/%s/self' % AID, {}, P1T)
    rep.check('D7b 自助签到成功（status=valid）',
              s == 200 and ck.get('checkin', {}).get('status') == 'valid', ck if s != 200 else '')
    s, ck2 = call(base, 'POST', '/api/cc/checkin/%s/self' % AID, {}, P1T)
    rep.check('D7c 重复扫码幂等 already_checked_in=true',
              s == 200 and ck2.get('already_checked_in') is True, ck2)

    call(base, 'POST', '/api/cc/activities/%s/checkin/close' % AID, {}, AT)
    s, e3 = call(base, 'POST', '/api/cc/checkin/%s/self' % AID, {}, P2T)
    rep.check('D8 签到已结束 → 400 checkin_closed', s == 400 and biz_code(e3) == 'checkin_closed', e3)

    # ---------- E. 问卷链路 ----------
    s, sv = call(base, 'POST', '/api/cc/activities/%s/surveys' % AID,
                 {'template_version_id': ver_id, 'title': '活动后问卷', 'role_scope': 'both'}, AT)
    SVID, QR = (sv.get('survey') or {}).get('id'), (sv.get('survey') or {}).get('qr_token')
    rep.check('E1 从模板创建问卷（物化 3 题）',
              s == 200 and bool(SVID) and sv.get('questions_copied') == 3, sv if s != 200 else '')

    s, meta0 = call(base, 'GET', '/api/cc/surveys/%s' % QR, token=P1T)
    rep.check('E2 未开放问卷 eligible=false 且 reasons 含 not_open',
              s == 200 and meta0.get('eligible') is False and 'not_open' in (meta0.get('reasons') or []),
              meta0 if s != 200 else '')

    s, _o = call(base, 'POST', '/api/cc/activity-surveys/%s/open' % SVID, {}, AT)
    rep.check('E3 开放问卷', s == 200, _o if s != 200 else '')

    s, meta = call(base, 'GET', '/api/cc/surveys/%s' % QR, token=P1T)
    qs = meta.get('questions') or []
    rep.check('E4 eligible=true + 题目下发（3 题，首题 is_sensitive）',
              s == 200 and meta.get('eligible') is True and len(qs) == 3
              and bool(qs[0].get('id')) and qs[0].get('is_sensitive') is True,
              meta if s != 200 else '')
    rep.check('E5 SurveyMeta 形态：survey.activity_id + activity.title + my_submission',
              meta.get('survey', {}).get('activity_id') == AID
              and meta.get('activity', {}).get('title') == '八月倾诉茶话会'
              and meta.get('my_submission') is None)

    answers = [{'question_code': 'MOOD', 'value': 4}, {'question_code': 'SAT', 'value': 'good'},
               {'question_code': 'NOTE', 'value': '很有收获'}]
    s, sub = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % SVID, {'answers': answers}, P1T)
    SUBID = (sub.get('submission') or {}).get('id')
    rep.check('E6 问卷提交（status=submitted）',
              s == 200 and bool(SUBID) and sub.get('submission', {}).get('status') == 'submitted',
              sub if s != 200 else '')
    s, sub2 = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % SVID, {'answers': answers}, P1T)
    rep.check('E7 重复提交幂等 idempotent=true', s == 200 and sub2.get('idempotent') is True, sub2)

    s, over = call(base, 'GET', '/api/cc/me/overview', token=P1T)
    os_ = over.get('open_surveys') or []
    sbs = over.get('submissions') or []
    rep.check('E8 me/overview：open_surveys 含 qr_token + my_submission',
              s == 200 and len(os_) == 1 and os_[0].get('survey', {}).get('qr_token') == QR
              and os_[0].get('activity_title') == '八月倾诉茶话会'
              and (os_[0].get('my_submission') or {}).get('status') == 'submitted',
              over if s != 200 else '')
    rep.check('E9 me/overview：submissions 含 survey_qr_token + activity_title',
              len(sbs) == 1 and sbs[0].get('survey_qr_token') == QR
              and sbs[0].get('submission', {}).get('id') == SUBID
              and sbs[0].get('activity_title') == '八月倾诉茶话会', sbs)
    regs = over.get('registrations') or []
    rep.check('E10 me/overview：registrations {registration, activity} 包裹形态',
              len(regs) == 1 and regs[0].get('registration', {}).get('status') == 'approved'
              and regs[0].get('activity', {}).get('id') == AID, regs)

    s, sd = call(base, 'GET', '/api/cc/submissions/%s' % SUBID, token=P1T)
    ans = sd.get('answers') or []
    rep.check('E11 submissions/:id 只读详情（survey_title/questions/answers[{question_code,value}]）',
              s == 200 and sd.get('survey_title') == '活动后问卷' and len(sd.get('questions') or []) == 3
              and all('question_code' in a and 'value' in a for a in ans)
              and next((a for a in ans if a['question_code'] == 'MOOD'), {}).get('value') == 4,
              sd if s != 200 else '')

    # E12 草稿预填：user_two 存草稿后元信息带 my_answers
    call(base, 'POST', '/api/cc/activity-surveys/%s/draft' % SVID,
         {'answers': [{'question_code': 'SAT', 'value': 'ok'}]}, P2T)
    s, meta2 = call(base, 'GET', '/api/cc/surveys/%s' % QR, token=P2T)
    ma = meta2.get('my_answers') or []
    rep.check('E12 草稿预填 my_answers 下发（元素 {question_code,value}）',
              s == 200 and meta2.get('my_submission', {}).get('status') == 'draft'
              and next((a for a in ma if a.get('question_code') == 'SAT'), {}).get('value') == 'ok',
              meta2 if s != 200 else '')

    # ---------- F. 看板 / 导出 / 备份 ----------
    ok_metrics = True
    detail = {}
    for mk, expect in [('applications', 2), ('approvals', 2), ('service_visits', 1),
                       ('unique_participants', 1), ('survey_submissions', 1)]:
        s, m = call(base, 'GET', '/api/cc/metrics/%s' % mk, token=AT)
        detail[mk] = (s, m.get('value'))
        ok_metrics = ok_metrics and s == 200 and m.get('value') == expect
    rep.check('F1 admin 看板指标口径（applications/approvals/service_visits/unique/survey_submissions）',
              ok_metrics, detail)
    s, rate = call(base, 'GET', '/api/cc/metrics/survey_completion_rate', token=AT)
    rep.check('F2 completion_rate value=0.5 且 denominator=2',
              s == 200 and rate.get('value') == 0.5 and rate.get('denominator') == 2, rate)
    s, ms = call(base, 'GET', '/api/cc/metrics/applications?organization_id=%s' % org_b, token=st)
    rep.check('F3 super 按机构筛选 metrics（机构B=0）', s == 200 and ms.get('value') == 0, ms)

    s, exp = call(base, 'POST', '/api/cc/exports',
                  {'scope': {'type': 'organization'}, 'include_pii': False}, AT)
    JOB = (exp.get('export_job') or {}).get('id')
    rep.check('F4 admin 创建导出 → {export_job:{id,...}}', s == 200 and bool(JOB),
              exp if s != 200 else '')
    s, blob = call(base, 'GET', '/api/cc/exports/%s/download' % JOB, token=AT, raw=True)
    rep.check('F5 导出 ZIP 下载 200 且为 PK 头',
              s == 200 and isinstance(blob, bytes) and blob[:2] == b'PK',
              'status=%s len=%s' % (s, len(blob) if isinstance(blob, bytes) else 0))

    s, br = call(base, 'POST', '/api/cc/super/backup/run', {}, st)
    rep.check('F6 手动备份 backup/run', s == 200 and br.get('ok') is True, br if s != 200 else '')
    s, bs = call(base, 'GET', '/api/cc/super/backup-status', token=st)
    lb = bs.get('last_backup') or {}
    rep.check('F7 backup-status {last_backup{result,file,created}, alert:false}',
              s == 200 and lb.get('result') == 'success' and bs.get('alert') is False
              and bool(lb.get('file')), bs)
    call(base, 'POST', '/api/cc/super/backup/run', {'force_fail': True}, st)
    s, bs2 = call(base, 'GET', '/api/cc/super/backup-status', token=st)
    rep.check('F8 故障注入后 alert=true（AC-23）',
              bs2.get('alert') is True and (bs2.get('last_backup') or {}).get('result') == 'failure', bs2)

    # ---------- G. 未认证错误形态 ----------
    s, ue = call(base, 'GET', '/api/cc/me/overview')
    rep.check('G1 未认证 401 错误体 {code,message,data:{code}}',
              s == 401 and 'message' in ue and biz_code(ue) is not None, ue)
    s, ue2 = call(base, 'POST', '/api/cc/checkin/%s/self' % AID, {})
    rep.check('G2 签到未认证 401', s == 401 and 'message' in ue2, ue2)
