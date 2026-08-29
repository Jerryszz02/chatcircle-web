# -*- coding: utf-8 -*-
"""suite_flow — 主链路全链路断言（自 /tmp/cc_e2e.py 联调脚本沉淀为正式产物）。

覆盖：邀请码 → 管理员注册/登录 → 建活动（数组版 form_config）→ 发布 →
预置存量参与者 → 公开详情 → 报名 → 审核 → 签到（错误分支 + 幂等）→
问卷（资格/草稿/提交幂等/只读答案/me 聚合）→ 看板指标口径 → 导出 ZIP →
备份端点下线形态（410/无审计）→ 未认证错误形态 →
现有/往期划分（公开列表 scope 过滤）与已结束活动报名截止（end_time 兜底）。

对应 AC：AC-02/04/05/06/09/11/12/14/15/16/20/23 的happy path 与关键分支；
专项反例（越权、并发、矩阵枚举、限流等）在各自套件。
"""
import csv
import io
import zipfile
from datetime import datetime, timedelta, timezone

import cc_fixture as fx
from cc_client import biz_code, call


def _csv_rows(zip_blob, name):
    """从导出 ZIP 中取指定 CSV 的数据行（去表头）；blob 非 ZIP 时返回 []。"""
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_blob))
        rows = list(csv.reader(io.StringIO(zf.read(name).decode('utf-8-sig'))))
        return rows[1:]
    except Exception:
        return []


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
                  {'invite_code': invite_token, 'username': 'FlowAdmin',
                   'email': 'flowadmin@it.cc.local', 'password': fx.PASSWORD})
    rep.check('B2 admin-register 成功且用户名小写归一',
              s == 200 and reg.get('record', {}).get('username') == 'flowadmin',
              reg if s != 200 else '')
    _, aauth = call(base, 'POST', '/api/collections/admin_accounts/auth-with-password',
                    {'identity': 'flowadmin', 'password': fx.PASSWORD})
    AT = aauth.get('token')
    rep.check('B3 管理员登录（小写用户名）', bool(AT), aauth)

    # ---------- C. 活动：创建（channel 停用）→ 发布 ----------
    # 活动时间为动态未来（30 天后）：已结束活动不再接受报名（end_time 计入报名开放判定），
    # 主链路报名/签到/问卷均在本场上跑，须保证未结束。
    now = datetime.now(timezone.utc)
    act_start = now + timedelta(days=30)
    s, act = call(base, 'POST', '/api/collections/activities/records', {
        'organization_id': org_a, 'activity_code': 'CC_IT_FLOW_01', 'title': '八月倾诉茶话会',
        'description': '测试活动', 'location': '线上',
        'start_time': fx.pb_dt(act_start), 'end_time': fx.pb_dt(act_start + timedelta(hours=2)),
        'status': 'draft', 'capacity_total': 10, 'capacity_speaker': 5, 'capacity_listener': 5,
        'registration_open': True,
        'registration_start_at': fx.pb_dt(now - timedelta(days=1)),
        'registration_end_at': fx.pb_dt(act_start),
        'group_tag': '',
        'form_config_json': {'fields': [
            {'field_def_id': fields['nickname'], 'enabled': True, 'required': True},
            {'field_def_id': fields['age'], 'enabled': True, 'required': False},
            {'field_def_id': fields['phone'], 'enabled': False, 'required': False},
            {'field_def_id': fields['channel'], 'enabled': False, 'required': False}]},
    }, AT)
    AID = act.get('id')
    rep.check('C1 管理员创建活动（数组版 form_config）', s == 200 and bool(AID),
              act if s != 200 else '')
    # 签到二维码 token 由服务端创建时生成（checkin_qr_token，FR-CHK-001），管理员读活动记录获取
    QR_CK = fx.checkin_token(base, AT, AID)
    rep.check('C1b 服务端自动生成签到二维码 token（24 位随机）',
              isinstance(QR_CK, str) and len(QR_CK) == 24, QR_CK)
    s, pub = call(base, 'POST', '/api/cc/activities/%s/publish' % AID, {}, AT)
    rep.check('C2 直接发布活动', s == 200 and pub.get('activity', {}).get('status') == 'published',
              pub if s != 200 else '')

    # ---------- D. 参与者链路 ----------
    P1, P1T, created = fx.create_participant(base, 'FlowUser_One')
    _, P2T, _ = fx.create_participant(base, 'flowuser_two')
    rep.check('D1 预置存量参与者夹具（用户名小写归一 + 可 impersonate）',
              created is True and bool(P1) and bool(P1T), [P1, created])

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
    s, e1 = fx.self_checkin(base, QR_CK, P2T)
    rep.check('D5 未审核签到 → 403 registration_not_approved',
              s == 403 and biz_code(e1) == 'registration_not_approved', e1)

    s, tr1 = call(base, 'POST', '/api/cc/registrations/%s/transition' % R1, {'to': 'approved'}, AT)
    rep.check('D6a 管理员审核通过 R1',
              s == 200 and tr1.get('registration', {}).get('status') == 'approved',
              tr1 if s != 200 else '')
    s, tr2 = call(base, 'POST', '/api/cc/registrations/%s/transition' % R2, {'to': 'approved'}, AT)
    rep.check('D6b 管理员审核通过 R2', s == 200, tr2 if s != 200 else '')
    s, e2 = fx.self_checkin(base, QR_CK, P1T)
    rep.check('D6c 签到未开放 → 400 checkin_not_open', s == 400 and biz_code(e2) == 'checkin_not_open', e2)

    s, oc = call(base, 'POST', '/api/cc/activities/%s/checkin/open' % AID, {}, AT)
    rep.check('D7a 开放签到', s == 200, oc if s != 200 else '')
    s, ck = fx.self_checkin(base, QR_CK, P1T)
    rep.check('D7b 自助签到成功（status=valid）',
              s == 200 and ck.get('checkin', {}).get('status') == 'valid', ck if s != 200 else '')
    s, ck2 = fx.self_checkin(base, QR_CK, P1T)
    rep.check('D7c 重复扫码幂等 already_checked_in=true',
              s == 200 and ck2.get('already_checked_in') is True, ck2)

    call(base, 'POST', '/api/cc/activities/%s/checkin/close' % AID, {}, AT)
    s, e3 = fx.self_checkin(base, QR_CK, P2T)
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

    # F3b~F3f 时间筛选重叠口径回归：活动 [start_time, end_time] 与筛选区间有交集即计入，
    # 看板 metrics 与导出共用同一口径（FR-DASH-002）。
    # 跨区间活动围绕主活动日期（act_start）布置：start 落在筛选区间之外，旧单点口径下被漏计。
    span_id = fx.create_activity(base, AT, org_a, 'CC_IT_FLOW_01B', '跨周倾诉茶话会',
                                 fields=[(fields['nickname'], True, True)],
                                 start=fx.pb_dt(act_start - timedelta(days=5)),
                                 end=fx.pb_dt(act_start + timedelta(days=5)))
    rep.check('F3b 跨区间活动创建并发布（主活动 ±5 天）', bool(span_id), span_id)
    day = lambda n: (act_start + timedelta(days=n)).strftime('%Y-%m-%d')
    s, m = call(base, 'GET',
                '/api/cc/metrics/activity_sessions?from=%s&to=%s' % (day(3), day(11)), token=AT)
    rep.check('F3c 重叠口径：start 在区间外但活动期重叠 → 计入（=1，不含主场次）',
              s == 200 and m.get('value') == 1, m)
    s, m = call(base, 'GET',
                '/api/cc/metrics/activity_sessions?from=%s&to=%s' % (day(6), day(11)), token=AT)
    rep.check('F3d 重叠口径：活动已结束（end < from）→ 不计入（=0）',
              s == 200 and m.get('value') == 0, m)
    s, m = call(base, 'GET',
                '/api/cc/metrics/activity_sessions?from=%s&to=%s' % (day(-1), day(1)), token=AT)
    rep.check('F3e 重叠口径：两场活动均与区间重叠 → 都计入（=2）',
              s == 200 and m.get('value') == 2, m)
    s, exp0 = call(base, 'POST', '/api/cc/exports',
                   {'scope': {'type': 'organization',
                              'date_range': {'from': day(3), 'to': day(11)}},
                    'include_pii': False}, AT)
    job0 = (exp0.get('export_job') or {}).get('id')
    s, blob0 = call(base, 'GET', '/api/cc/exports/%s/download' % job0, token=AT, raw=True)
    acts0 = _csv_rows(blob0, 'activities.csv') if s == 200 else []
    rep.check('F3f 导出与看板同口径（FR-DASH-002）：date_range 13~21 仅含跨区间场（1 行）',
              s == 200 and len(acts0) == 1 and acts0 and acts0[0][0] == span_id,
              {'status': s, 'rows': len(acts0)})

    s, exp = call(base, 'POST', '/api/cc/exports',
                  {'scope': {'type': 'organization'}, 'include_pii': False}, AT)
    JOB = (exp.get('export_job') or {}).get('id')
    rep.check('F4 admin 创建导出 → {export_job:{id,...}}', s == 200 and bool(JOB),
              exp if s != 200 else '')
    s, blob = call(base, 'GET', '/api/cc/exports/%s/download' % JOB, token=AT, raw=True)
    rep.check('F5 导出 ZIP 下载 200 且为 PK 头',
              s == 200 and isinstance(blob, bytes) and blob[:2] == b'PK',
              'status=%s len=%s' % (s, len(blob) if isinstance(blob, bytes) else 0))

    # F6~F8：backup/run 已下线（410 Gone，假备份治理）；每日一致性快照由 deploy/backup.sh
    # 自动执行，backup-status 的 backup.* 审计口径与告警联动由 suite_backup 覆盖
    s, br = call(base, 'POST', '/api/cc/super/backup/run', {}, st)
    rep.check('F6 手动备份 backup/run → 410 backup_deprecated',
              s == 410 and biz_code(br) == 'backup_deprecated', br)
    s, bs = call(base, 'GET', '/api/cc/super/backup-status', token=st)
    rep.check('F7 backup-status 尚无备份记录 → last_backup=null 且 alert=true',
              s == 200 and bs.get('last_backup') is None and bs.get('alert') is True
              and bool(bs.get('message')), bs)
    s, ba = call(base, 'GET',
                 "/api/collections/audit_logs/records?filter=(action='backup.success'||action='backup.failed')",
                 token=st)
    rep.check('F8 backup/run 不再写 backup.* 审计', s == 200 and ba.get('totalItems') == 0, ba)

    # ---------- G. 未认证错误形态 ----------
    s, ue = call(base, 'GET', '/api/cc/me/overview')
    rep.check('G1 未认证 401 错误体 {code,message,data:{code}}',
              s == 401 and 'message' in ue and biz_code(ue) is not None, ue)
    s, ue2 = call(base, 'POST', '/api/cc/checkin/self', {'token': QR_CK})
    rep.check('G2 签到未认证 401', s == 401 and 'message' in ue2, ue2)

    # ---------- H. 分角色报名问卷（registration_field_defs.role_scope） ----------
    # 机构自定义字段承载角色标记（平台标准字段保持 both，避免污染其他套件共享 fixture）
    s, fspk = call(base, 'POST', '/api/collections/registration_field_defs/records',
                   {'organization_id': org_a, 'field_code': 'speaker_topic', 'field_type': 'text',
                    'label': '想聊的话题', 'source_type': 'custom', 'is_sensitive': False,
                    'options_json': None, 'required_default': True, 'status': 'active',
                    'role_scope': 'speaker'}, AT)
    SPK_F = fspk.get('id')
    s, flis = call(base, 'POST', '/api/collections/registration_field_defs/records',
                   {'organization_id': org_a, 'field_code': 'listener_exp', 'field_type': 'text',
                    'label': '倾听经历', 'source_type': 'custom', 'is_sensitive': False,
                    'options_json': None, 'required_default': True, 'status': 'active',
                    'role_scope': 'listener'}, AT)
    LIS_F = flis.get('id')
    rep.check('H1 角色专属自定义字段创建成功（speaker/listener）', bool(SPK_F) and bool(LIS_F),
              [fspk, flis])
    act2 = fx.create_activity(base, AT, org_a, 'CC_IT_FLOW_02', '分角色报名表场',
                              fields=[(fields['nickname'], True, True),
                                      (SPK_F, True, True),
                                      (LIS_F, True, True)])

    s, det2 = call(base, 'GET', '/api/cc/public/activities/%s' % act2)
    rf2 = {f.get('field_code'): f for f in (det2.get('registration_fields') or [])}
    rep.check('H2 公开详情 registration_fields 下发 role_scope（both/speaker/listener）',
              s == 200 and rf2.get('nickname', {}).get('role_scope') == 'both'
              and rf2.get('speaker_topic', {}).get('role_scope') == 'speaker'
              and rf2.get('listener_exp', {}).get('role_scope') == 'listener',
              det2 if s != 200 else rf2)

    _, PRL_T, _ = fx.create_participant(base, 'flow_role_lis')
    _, PRS_T, _ = fx.create_participant(base, 'flow_role_spk')

    s, r = call(base, 'POST', '/api/cc/activities/%s/register' % act2,
                {'activity_role': 'listener',
                 'answers': [{'field_def_id': fields['nickname'], 'value': '角色聆'},
                             {'field_def_id': SPK_F, 'value': '不适用字段答案'}]}, PRL_T)
    rep.check('H3 listener 提交 speaker 专属字段答案 → 400 field_not_applicable',
              s == 400 and biz_code(r) == 'field_not_applicable', r)
    s, r = call(base, 'POST', '/api/cc/activities/%s/register' % act2,
                {'activity_role': 'listener',
                 'answers': [{'field_def_id': fields['nickname'], 'value': '角色聆'}]}, PRL_T)
    rep.check('H4 listener 缺 listener 专属必填 → 400 REQUIRED_FIELD_MISSING',
              s == 400 and biz_code(r) == 'REQUIRED_FIELD_MISSING', r)
    s, r = call(base, 'POST', '/api/cc/activities/%s/register' % act2,
                {'activity_role': 'listener',
                 'answers': [{'field_def_id': LIS_F, 'value': '三年倾听'}]}, PRL_T)
    rep.check('H5 both 必填字段对 listener 生效（缺 nickname → 400）',
              s == 400 and biz_code(r) == 'REQUIRED_FIELD_MISSING', r)
    s, r = call(base, 'POST', '/api/cc/activities/%s/register' % act2,
                {'activity_role': 'listener',
                 'answers': [{'field_def_id': fields['nickname'], 'value': '角色聆'},
                             {'field_def_id': LIS_F, 'value': '三年倾听'}]}, PRL_T)
    rep.check('H6 listener 仅适用字段提交成功（speaker 专属不参与校验）', s == 200, r)

    s, r = call(base, 'POST', '/api/cc/activities/%s/register' % act2,
                {'activity_role': 'speaker',
                 'answers': [{'field_def_id': fields['nickname'], 'value': '角色倾'},
                             {'field_def_id': LIS_F, 'value': '不适用字段答案'}]}, PRS_T)
    rep.check('H7 speaker 提交 listener 专属字段答案 → 400 field_not_applicable',
              s == 400 and biz_code(r) == 'field_not_applicable', r)
    s, r = call(base, 'POST', '/api/cc/activities/%s/register' % act2,
                {'activity_role': 'speaker',
                 'answers': [{'field_def_id': fields['nickname'], 'value': '角色倾'},
                             {'field_def_id': SPK_F, 'value': '亲子沟通'}]}, PRS_T)
    rep.check('H8 speaker 无需 listener 专属必填即可提交（both 字段正常校验）', s == 200, r)

    s, ov1 = call(base, 'GET', '/api/cc/me/overview', token=P1T)
    s2, ov2 = call(base, 'GET', '/api/cc/me/overview', token=P2T)
    rep.check('H9 me/overview：has_approved_listener_registration 倾诉者=false / 已过审聆听者=true',
              s == 200 and ov1.get('has_approved_listener_registration') is False
              and s2 == 200 and ov2.get('has_approved_listener_registration') is True,
              [ov1.get('has_approved_listener_registration'),
               ov2.get('has_approved_listener_registration')])

    # ---------- I. 现有/往期划分（scope）与已结束活动报名截止（2026-08 往期活动改版） ----------
    # 「已结束但机构未手动关闭」场次：end_time 已过、status 仍 published、报名窗口仍开放
    ended_start = now - timedelta(days=14)
    act_ended = fx.create_activity(base, AT, org_a, 'CC_IT_FLOW_03', '已结束未关闭场',
                                   fields=[(fields['nickname'], True, True)],
                                   start=fx.pb_dt(ended_start),
                                   end=fx.pb_dt(ended_start + timedelta(hours=2)))
    s, det3 = call(base, 'GET', '/api/cc/public/activities/%s' % act_ended)
    rep.check('I1 已结束未关闭活动详情：registration.open=false 且 reason=ended',
              s == 200 and det3.get('registration', {}).get('open') is False
              and det3.get('registration', {}).get('reason') == 'ended', det3)
    _, P3T, _ = fx.create_participant(base, 'flow_user_three')
    s, r3 = call(base, 'POST', '/api/cc/activities/%s/register' % act_ended,
                 {'activity_role': 'speaker',
                  'answers': [{'field_def_id': fields['nickname'], 'value': '阿三'}]},
                 P3T)
    rep.check('I2 已结束活动提交报名 → 400 REGISTRATION_CLOSED',
              s == 400 and biz_code(r3) == 'REGISTRATION_CLOSED', r3)

    # 提前手动关闭（end_time 未到）的场次同样归往期
    act_closed = fx.create_activity(base, AT, org_a, 'CC_IT_FLOW_04', '提前关闭场',
                                    fields=[(fields['nickname'], True, True)])
    s, cl = call(base, 'POST', '/api/cc/activities/%s/close' % act_closed, {}, AT)
    rep.check('I3 手动关闭活动（end_time 未到）前置', s == 200, cl)

    s, allr = call(base, 'GET', '/api/cc/public/activities')
    all_ids = [a.get('id') for a in (allr.get('activities') or [])]
    ended_in_all = next((a for a in (allr.get('activities') or []) if a.get('id') == act_ended),
                        None)
    rep.check('I4 不传 scope 返回全部（兼容），已结束场列表口径 open=false/reason=ended',
              s == 200 and act_ended in all_ids and AID in all_ids
              and ended_in_all is not None
              and ended_in_all.get('registration', {}).get('open') is False
              and ended_in_all.get('registration', {}).get('reason') == 'ended',
              ended_in_all if s == 200 else allr)
    s, cur = call(base, 'GET', '/api/cc/public/activities?scope=current')
    cur_ids = [a.get('id') for a in (cur.get('activities') or [])]
    rep.check('I5 scope=current 只含未结束场次（不含已结束/已关闭场）',
              s == 200 and AID in cur_ids
              and act_ended not in cur_ids and act_closed not in cur_ids, cur)
    s, pst = call(base, 'GET', '/api/cc/public/activities?scope=past')
    pst_ids = [a.get('id') for a in (pst.get('activities') or [])]
    rep.check('I6 scope=past 含已结束场与已关闭场，不含未结束场次',
              s == 200 and act_ended in pst_ids and act_closed in pst_ids
              and AID not in pst_ids, pst)
