# -*- coding: utf-8 -*-
"""suite_trainings — 聆听者培训体系（生命周期/直连守卫/签到资格/幂等/补签/撤销/me 聚合）。

断言：
- 培训直连创建强制 draft（非 draft 403），checkin_qr_token 服务端自动生成（24 位），
  status/签到集合直连写被 guards 拦截；
- 状态机 draft→published→closed：非法迁移 400 ILLEGAL_TRANSITION，同态幂等 already=true；
- 签到资格：仅 approved 聆听者可签到（pending 聆听者 / approved 倾诉者 / 无报名 →
  403 listener_not_approved）；未开放 checkin_not_open、已结束 checkin_closed、
  草稿培训 CHECKIN_UNAVAILABLE、错误 token 404；
- 重复扫码幂等；关闭场次后已签到者重扫仍幂等返回；
- 补签原因必填 + 幂等 + 候选人名单口径（全平台 approved 聆听者去重）；
- 撤销保留记录 + 审计，撤销后可重签；
- GET /api/cc/me/trainings：eligible / trained / trainings / my_attendance 形态，
  不下发 checkin_qr_token；未 eligible 时列表恒空。

限流约定：本套件管理员登录态经「超管直建 + impersonate」获取
（fx.create_admin_via_impersonate），不新增内置 auth-with-password 调用
（per-IP 限流预算为 0，见 backend/tests/README.md）。
"""
import cc_fixture as fx
from cc_client import biz_code, call


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    fields = ctx['fields']
    rep.section('suite_trainings：聆听者培训体系（生命周期/签到/资格/幂等/补签/撤销）')

    # ---------- fixture：机构 + 管理员（impersonate）+ 资格活动 + 五种参与者 ----------
    org = fx.create_org(base, st, '培训机构')
    _, AT = fx.create_admin_via_impersonate(base, st, org, 'trn_admin')
    act = fx.create_activity(base, AT, org, 'CC_IT_TRN_01', '培训资格场',
                             fields=fx.nick_field_cfg(fields), caps=(20, 10, 10))

    PL1, PT_L1, _ = fx.create_participant(base, 'trn_lis_1')
    PL2, PT_L2, _ = fx.create_participant(base, 'trn_lis_2')
    PL3, PT_L3, _ = fx.create_participant(base, 'trn_lis_3')
    PS1, PT_S1, _ = fx.create_participant(base, 'trn_spk_1')
    PN1, PT_N1, _ = fx.create_participant(base, 'trn_none_1')
    reg_l1 = fx.register(base, PT_L1, act, 'listener', fx.field_answers(fields, '培训聆1'))
    fx.register(base, PT_L2, act, 'listener', fx.field_answers(fields, '培训聆2'))  # 保持待审核
    reg_l3 = fx.register(base, PT_L3, act, 'listener', fx.field_answers(fields, '培训聆3'))
    reg_s1 = fx.register(base, PT_S1, act, 'speaker', fx.field_answers(fields, '培训倾1'))
    fx.transition(base, AT, reg_l1, 'approved')
    fx.transition(base, AT, reg_l3, 'approved')
    fx.transition(base, AT, reg_s1, 'approved')

    # ---------- 1. 创建与直连守卫 ----------
    s, r = fx.create_training(base, AT, org, 'CC_IT_TRN_T0', '直接发布尝试', status='published')
    rep.check('TRN-01 直连创建培训 status!=draft → 403（守卫拦截）', s == 403, r)
    s, t1 = fx.create_training(base, AT, org, 'CC_IT_TRN_T1', '聆听者培训一期')
    T1 = t1.get('id')
    rep.check('TRN-02 创建培训成功（draft）', s == 200 and t1.get('status') == 'draft', t1)
    s, t1v = call(base, 'GET', '/api/collections/trainings/records/%s' % T1, token=AT)
    rep.check('TRN-03 服务端自动生成签到 token（24 位随机）',
              s == 200 and isinstance(t1v.get('checkin_qr_token'), str)
              and len(t1v.get('checkin_qr_token')) == 24, t1v)
    QR_T1 = t1v.get('checkin_qr_token')
    s, r = call(base, 'PATCH', '/api/collections/trainings/records/%s' % T1,
                {'status': 'published'}, AT)
    rep.check('TRN-04 直连改培训 status → 403（守卫拦截）', s == 403, r)
    s, r = call(base, 'POST', '/api/collections/training_checkin_sessions/records',
                {'training_id': T1, 'status': 'open', 'opened_at': '2026-08-15 12:00:00Z',
                 'opened_by': 'x'}, AT)
    rep.check('TRN-05 直连创建 training_checkin_sessions → 403（守卫拦截）', s == 403, r)
    s, r = call(base, 'POST', '/api/collections/training_attendances/records',
                {'training_id': T1, 'participant_id': PL1, 'source': 'manual',
                 'status': 'valid', 'checked_in_at': '2026-08-15 12:30:00Z'}, AT)
    rep.check('TRN-06 直连创建 training_attendances → 403（守卫拦截）', s == 403, r)

    # T2 用于状态机边缘；T3 永不发布（草稿 token 攻击向量）
    _, t2 = fx.create_training(base, AT, org, 'CC_IT_TRN_T2', '状态机边缘场')
    T2 = t2.get('id')
    _, t3 = fx.create_training(base, AT, org, 'CC_IT_TRN_T3', '永远草稿场')
    T3 = t3.get('id')
    QR_T3 = fx.training_token(base, AT, T3)

    # ---------- 2. 状态机 ----------
    s, r = call(base, 'POST', '/api/cc/trainings/%s/close' % T2, {}, AT)
    rep.check('TRN-07 关闭草稿培训 → 400 ILLEGAL_TRANSITION',
              s == 400 and biz_code(r) == 'ILLEGAL_TRANSITION', r)
    s, r = call(base, 'POST', '/api/cc/trainings/%s/publish' % T2, {}, AT)
    rep.check('TRN-08 发布草稿培训 → published',
              s == 200 and (r.get('training') or {}).get('status') == 'published', r)
    s, r = call(base, 'POST', '/api/cc/trainings/%s/publish' % T2, {}, AT)
    rep.check('TRN-09 重复发布幂等 already=true', s == 200 and r.get('already') is True, r)
    s, r = call(base, 'POST', '/api/cc/trainings/%s/close' % T2, {}, AT)
    rep.check('TRN-10 关闭已发布培训 → closed',
              s == 200 and (r.get('training') or {}).get('status') == 'closed', r)
    s, r = call(base, 'POST', '/api/cc/trainings/%s/close' % T2, {}, AT)
    rep.check('TRN-11 重复关闭幂等 already=true', s == 200 and r.get('already') is True, r)
    s, r = call(base, 'POST', '/api/cc/trainings/%s/publish' % T2, {}, AT)
    rep.check('TRN-12 已关闭培训再发布 → 400 ILLEGAL_TRANSITION',
              s == 400 and biz_code(r) == 'ILLEGAL_TRANSITION', r)
    s, r = call(base, 'POST', '/api/cc/trainings/%s/publish' % T1, {}, AT)
    rep.check('TRN-13 发布 T1（签到测试主场地）', s == 200, r)
    s, r = call(base, 'POST', '/api/cc/trainings/%s/checkin/open' % T3, {}, AT)
    rep.check('TRN-14 草稿培训开放签到 → 400 TRAINING_NOT_OPEN',
              s == 400 and biz_code(r) == 'TRAINING_NOT_OPEN', r)

    # ---------- 3. 签到资格与开放分支 ----------
    s, r = fx.self_training_checkin(base, QR_T1, PT_L2)
    rep.check('TRN-15 待审核聆听者扫码 → 403 listener_not_approved',
              s == 403 and biz_code(r) == 'listener_not_approved', r)
    s, r = fx.self_training_checkin(base, QR_T1, PT_S1)
    rep.check('TRN-16 approved 倾诉者扫码 → 403 listener_not_approved',
              s == 403 and biz_code(r) == 'listener_not_approved', r)
    s, r = fx.self_training_checkin(base, QR_T1, PT_N1)
    rep.check('TRN-17 无报名者扫码 → 403 listener_not_approved',
              s == 403 and biz_code(r) == 'listener_not_approved', r)
    s, r = fx.self_training_checkin(base, QR_T1, PT_L1)
    rep.check('TRN-18 签到未开放 → 400 checkin_not_open',
              s == 400 and biz_code(r) == 'checkin_not_open', r)

    s, r = call(base, 'POST', '/api/cc/trainings/%s/checkin/open' % T1, {}, AT)
    SES1 = (r.get('session') or {}).get('id')
    rep.check('TRN-19 开放签到（created=true）', s == 200 and r.get('created') is True and SES1, r)
    s, r = call(base, 'POST', '/api/cc/trainings/%s/checkin/open' % T1, {}, AT)
    rep.check('TRN-20 重复开放幂等（同一场次，created=false）',
              s == 200 and r.get('created') is False
              and (r.get('session') or {}).get('id') == SES1, r)

    s, r = fx.self_training_checkin(base, QR_T1, PT_L1)
    ATT1 = (r.get('attendance') or {}).get('id')
    rep.check('TRN-21 已通过聆听者开放期首签成功（valid/self_scan）',
              s == 200 and (r.get('attendance') or {}).get('status') == 'valid'
              and (r.get('attendance') or {}).get('source') == 'self_scan'
              and r.get('already_checked_in') is False, r)
    s, r = fx.self_training_checkin(base, QR_T1, PT_L1)
    rep.check('TRN-22 重复扫码幂等（同一记录，不新建）',
              s == 200 and r.get('already_checked_in') is True
              and (r.get('attendance') or {}).get('id') == ATT1, r)

    s, r = call(base, 'POST', '/api/cc/trainings/%s/checkin/close' % T1, {}, AT)
    rep.check('TRN-23 关闭签到（closed=true）', s == 200 and r.get('closed') is True, r)
    s, r = fx.self_training_checkin(base, QR_T1, PT_L3)
    rep.check('TRN-24 签到已结束 → 400 checkin_closed',
              s == 400 and biz_code(r) == 'checkin_closed', r)
    s, r = fx.self_training_checkin(base, QR_T1, PT_L1)
    rep.check('TRN-25 已签到者关闭期重复扫码仍幂等返回（不报错）',
              s == 200 and r.get('already_checked_in') is True, r)

    s, r = fx.self_training_checkin(base, 'nonexistent_token_000', PT_L1)
    rep.check('TRN-26 错误 token → 404 TRAINING_NOT_FOUND',
              s == 404 and biz_code(r) == 'TRAINING_NOT_FOUND', r)
    s, r = fx.self_training_checkin(base, QR_T3, PT_L1)
    rep.check('TRN-27 草稿培训扫码 → 400 CHECKIN_UNAVAILABLE',
              s == 400 and biz_code(r) == 'CHECKIN_UNAVAILABLE', r)
    s, r = call(base, 'POST', '/api/cc/training-checkin/self', {'token': QR_T1})
    rep.check('TRN-28 未认证自助签到 → 401', s == 401, r)

    # ---------- 4. 补签 ----------
    s, r = call(base, 'POST', '/api/cc/training-checkins/manual',
                {'training_id': T1, 'participant_id': PL3}, AT)
    rep.check('TRN-29 补签缺原因 → 400 REASON_REQUIRED',
              s == 400 and biz_code(r) == 'REASON_REQUIRED', r)
    s, r = call(base, 'POST', '/api/cc/training-checkins/manual',
                {'training_id': T1, 'participant_id': PL2, 'reason': '现场补录'}, AT)
    rep.check('TRN-30 为待审核聆听者补签 → 400 listener_not_approved',
              s == 400 and biz_code(r) == 'listener_not_approved', r)
    s, r = call(base, 'POST', '/api/cc/training-checkins/manual',
                {'training_id': T1, 'participant_id': PL3, 'reason': '现场补录'}, AT)
    ATT3 = (r.get('attendance') or {}).get('id')
    rep.check('TRN-31 补签成功（source=manual，不要求场次开放）',
              s == 200 and (r.get('attendance') or {}).get('source') == 'manual'
              and (r.get('attendance') or {}).get('status') == 'valid', r)
    s, r = call(base, 'POST', '/api/cc/training-checkins/manual',
                {'training_id': T1, 'participant_id': PL3, 'reason': '重复补录'}, AT)
    rep.check('TRN-32 重复补签幂等（existing=true，不新建）',
              s == 200 and r.get('existing') is True
              and (r.get('attendance') or {}).get('id') == ATT3, r)

    s, r = call(base, 'GET', '/api/cc/trainings/%s/checkin/manual-candidates' % T1, token=AT)
    cands = r.get('candidates') or []
    usernames = [c.get('username') for c in cands]
    rep.check('TRN-33 补签候选人含 approved 聆听者、排除待审核/倾诉者/无报名',
              s == 200 and 'trn_lis_1' in usernames and 'trn_lis_3' in usernames
              and 'trn_lis_2' not in usernames and 'trn_spk_1' not in usernames
              and 'trn_none_1' not in usernames, usernames)
    rep.check('TRN-34 候选人按参与者去重',
              s == 200 and len(usernames) == len(set(usernames)), usernames)

    # ---------- 5. 撤销（保留记录 + 审计 + 可重签） ----------
    s, r = call(base, 'POST', '/api/cc/training-checkins/%s/revoke' % ATT1, {}, AT)
    rep.check('TRN-35 撤销缺原因 → 400 REASON_REQUIRED',
              s == 400 and biz_code(r) == 'REASON_REQUIRED', r)
    s, r = call(base, 'POST', '/api/cc/training-checkins/%s/revoke' % ATT1, {'reason': '代签核查'}, AT)
    rep.check('TRN-36 撤销成功（status=revoked，不删行）',
              s == 200 and (r.get('attendance') or {}).get('status') == 'revoked', r)
    s, r = call(base, 'GET', '/api/collections/training_attendances/records/%s' % ATT1, token=AT)
    rep.check('TRN-37 原签到记录保留可查（status=revoked + reason）',
              s == 200 and r.get('status') == 'revoked' and r.get('reason') == '代签核查', r)
    s, r = call(base, 'POST', '/api/cc/training-checkins/%s/revoke' % ATT1, {'reason': '重复撤销'}, AT)
    rep.check('TRN-38 重复撤销幂等 already_revoked=true',
              s == 200 and r.get('already_revoked') is True, r)
    s, r = call(base, 'GET',
                f"/api/collections/audit_logs/records?filter=(action='training.attendance_revoke'%26%26target_id='{ATT1}')",
                token=st)
    items = r.get('items') or []
    rep.check('TRN-39 撤销写审计（原因入审计）',
              s == 200 and len(items) == 1 and items[0].get('reason') == '代签核查', items)

    call(base, 'POST', '/api/cc/trainings/%s/checkin/open' % T1, {}, AT)
    s, r = fx.self_training_checkin(base, QR_T1, PT_L1)
    ATT1B = (r.get('attendance') or {}).get('id')
    rep.check('TRN-40 撤销后重新签到成功（新一条 valid）',
              s == 200 and (r.get('attendance') or {}).get('status') == 'valid'
              and r.get('already_checked_in') is False and ATT1B != ATT1, r)

    # ---------- 6. me/trainings 聚合 ----------
    s, r = call(base, 'GET', '/api/cc/me/trainings', token=PT_L2)
    rep.check('TRN-41 未过审聆听者：eligible=false / trained=false / 列表恒空',
              s == 200 and r.get('eligible') is False and r.get('trained') is False
              and r.get('trainings') == [], r)
    s, r = call(base, 'GET', '/api/cc/me/trainings', token=PT_L1)
    items = r.get('trainings') or []
    by_id = {t.get('id'): t for t in items}
    mine1 = by_id.get(T1) or {}
    rep.check('TRN-42 已签到聆听者：eligible=true / trained=true / 含 T1 且 my_attendance=valid',
              s == 200 and r.get('eligible') is True and r.get('trained') is True
              and (mine1.get('my_attendance') or {}).get('status') == 'valid'
              and bool((mine1.get('my_attendance') or {}).get('checked_in_at')), r)
    rep.check('TRN-43 列表不含草稿培训 T3、不含无本人记录的 closed 培训 T2',
              T3 not in by_id and T2 not in by_id, [t.get('id') for t in items])
    rep.check('TRN-44 列表项不下发 checkin_qr_token',
              all('checkin_qr_token' not in t for t in items), items)

    s, ov_l = call(base, 'GET', '/api/cc/me/overview', token=PT_L1)
    s2, ov_s = call(base, 'GET', '/api/cc/me/overview', token=PT_S1)
    rep.check('TRN-45 me/overview：has_approved_listener_registration 聆听者=true / 倾诉者=false',
              s == 200 and ov_l.get('has_approved_listener_registration') is True
              and s2 == 200 and ov_s.get('has_approved_listener_registration') is False,
              [ov_l.get('has_approved_listener_registration'),
               ov_s.get('has_approved_listener_registration')])

    # 关闭 T1 后：本人有出席记录的 closed 培训仍保留在列表中
    s, r = call(base, 'POST', '/api/cc/trainings/%s/close' % T1, {}, AT)
    rep.check('TRN-46 关闭 T1', s == 200, r)
    s, r = call(base, 'GET', '/api/cc/me/trainings', token=PT_L1)
    by_id = {t.get('id'): t for t in (r.get('trainings') or [])}
    mine1 = by_id.get(T1) or {}
    rep.check('TRN-47 培训关闭后本人记录仍可回看（closed + my_attendance=valid），trained 不变',
              s == 200 and mine1.get('status') == 'closed'
              and (mine1.get('my_attendance') or {}).get('status') == 'valid'
              and r.get('trained') is True, r)
    s, r = call(base, 'GET', '/api/cc/me/trainings', token=PT_L3)
    by_id = {t.get('id'): t for t in (r.get('trainings') or [])}
    rep.check('TRN-48 补签参与者同样 trained=true 且 closed 培训可回看（manual 记录）',
              s == 200 and r.get('trained') is True
              and ((by_id.get(T1) or {}).get('my_attendance') or {}).get('status') == 'valid', r)
