# -*- coding: utf-8 -*-
"""suite_hardening — 2026-08 安全加固回归套件（批次 A/B/C 契约锁定）。

覆盖：
1. 直连写守卫矩阵（guards.pb.js）：非超管直连 create/update 业务集合一律 403，
   业务写只能走 /api/cc/* 端点（资格校验/状态机/事务为唯一服务端强制点）；超管放行。
2. 账号停用不可自助复活：status 自改被 updateRule（先触发，404）或守卫（403）拦截。
3. 内置认证限流（authguard.pb.js）：同一身份连续 5 次错误密码后第 6 次起 429，
   限流期间正确密码同样被拒（TOO_MANY_ATTEMPTS）。
4. CSV 公式注入中和：导出单元格以 = + - @ / Tab 开头的值前置单引号（exports.pb.js）。
5. 答案值形态校验：scale_1_5 超范围、scale_0_10 非整数/超范围（须 0~10 整数）、
   非法选项值、文本超 2000 字符均 400 validation_failed。
6. 签到二维码面：原生 view 关闭、公开端点不泄露 checkin_qr_token、错误 token 404、
   直连创建自带 checkin_qr_token 被服务端无条件覆盖为 24 位随机串。
7. 活动状态机补强：下架活动审核报名 400 ACTIVITY_UNAVAILABLE；草稿活动开放签到
   400 ACTIVITY_NOT_OPEN。

⚠️ 内置认证 per-IP 限流预算（authguard：全集合共享 25 次/10 分钟滑窗，含成功尝试；
2026-08 改版由 20 上调——suite_admin_email 的邮箱+密码登录需 1 次内置认证）：
本套件依赖「到达第 3 节时，本次运行累计内置 auth-with-password 尝试 ≤15 次」。
当前全套件用量：super_login 1 + 各套件管理员登录 13 + suite_admin_email 邮箱登录 1
= 15（suite_nodelete 第二管理员刻意超管直建不登录）。本套件在第 3 节前只做 1 次
管理员登录（fixture），限流用例固定为 5×400 + 第 6 次 429（第 6 次为 per-IP 第 22 次，
未触 per-IP 上限，429 来自 per-身份+IP 连败桶，断言仍成立）。
新增套件时：内置 auth 调用须控制在预算内（上限 25，当前全量 22，余量 3），
超额会导致本套件限流断言提前被 per-IP 桶拦截；本套件必须排在 runner 最后执行。
"""
import csv
import io
import json
import zipfile

import cc_fixture as fx
from cc_client import biz_code, call


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    fields, ver_id = ctx['fields'], ctx['ver_id']
    rep.section('suite_hardening：安全加固回归（直连守卫/账号复活/认证限流/CSV/QR/状态机）')

    # ---------- fixture：机构 + 管理员 + 活动 + 参与者 ----------
    # 本套件唯一一次内置 auth-with-password 登录（预算见文件头注释）
    org = fx.create_org(base, st, '加固机构')
    _, AT = fx.create_admin(base, st, org, 'hd_admin')
    act = fx.create_activity(base, AT, org, 'CC_IT_HARD_01', '加固校验场',
                             fields=[(fields['nickname'], True, True)])
    qr = fx.checkin_token(base, AT, act)
    P1, PT1, _ = fx.create_participant(base, 'hd_user1')
    reg1 = fx.register(base, PT1, act, 'speaker',
                       fx.field_answers(fields, '加固甲'))  # 待审核报名（供状态机用例）

    # ---------- 1. 直连写守卫矩阵（guards.pb.js）----------
    # 参与者直连 POST registrations：createRule 放行本人 pending，守卫 403 拦截
    s, r = call(base, 'POST', '/api/collections/registrations/records',
                {'activity_id': act, 'participant_id': P1, 'activity_role': 'listener',
                 'status': 'pending', 'submitted_at': '2026-08-09 00:00:00Z'}, PT1)
    rep.check('HG-01 参与者直连创建报名 → 403（守卫）', s == 403, r)
    # 机构管理员直连 PATCH registrations.status：updateRule 放行本机构，守卫 403
    s, r = call(base, 'PATCH', '/api/collections/registrations/records/%s' % reg1,
                {'status': 'approved'}, AT)
    rep.check('HG-02 管理员直连改报名状态 → 403（守卫）', s == 403, r)
    # 参与者直连 POST registration_answers：createRule 放行本人报名，守卫 403
    s, r = call(base, 'POST', '/api/collections/registration_answers/records',
                {'registration_id': reg1, 'field_def_id': fields['nickname'],
                 'value_json': '绕过端点'}, PT1)
    rep.check('HG-03 参与者直连写报名答案 → 403（守卫）', s == 403, r)
    # 管理员直连 POST/PATCH checkin_sessions：规则放行本机构，守卫 403
    s, r = call(base, 'POST', '/api/collections/checkin_sessions/records',
                {'activity_id': act, 'status': 'open', 'opened_at': '2026-08-09 00:00:00Z',
                 'opened_by': 'hd_admin'}, AT)
    rep.check('HG-04 管理员直连创建签到场次 → 403（守卫）', s == 403, r)
    # 先经端点真实开放一场签到，再尝试直连篡改
    call(base, 'POST', '/api/cc/activities/%s/checkin/open' % act, {}, AT)
    s, ses = call(base, 'GET',
                  "/api/collections/checkin_sessions/records?perPage=1&filter=(activity_id='%s')" % act,
                  token=st)
    ses_id = (ses.get('items') or [{}])[0].get('id')
    s, r = call(base, 'PATCH', '/api/collections/checkin_sessions/records/%s' % ses_id,
                {'status': 'closed'}, AT)
    rep.check('HG-05 管理员直连改签到场次 → 403（守卫）', s == 403 and bool(ses_id), r)
    call(base, 'POST', '/api/cc/activities/%s/checkin/close' % act, {}, AT)
    # 管理员直连 POST activities 带 status='published'：创建强制 draft，守卫 403
    s, r = call(base, 'POST', '/api/collections/activities/records', {
        'organization_id': org, 'activity_code': 'CC_IT_HARD_02', 'title': '直连发布尝试',
        'description': 'x', 'location': '线上',
        'start_time': '2026-08-10 12:00:00Z', 'end_time': '2026-08-10 14:00:00Z',
        'status': 'published', 'capacity_total': 10, 'capacity_speaker': 5,
        'capacity_listener': 5, 'registration_open': True,
        'registration_start_at': '2026-08-01 00:00:00Z',
        'registration_end_at': '2026-12-31 23:59:59Z', 'group_tag': '',
        'form_config_json': {'fields': []}}, AT)
    rep.check('HG-06 管理员直连创建已发布活动 → 403（创建强制 draft）', s == 403, r)
    # 管理员直连 PATCH activities.status：状态机流转禁直连，守卫 403
    s, r = call(base, 'PATCH', '/api/collections/activities/records/%s' % act,
                {'status': 'closed'}, AT)
    rep.check('HG-07 管理员直连改活动状态 → 403（守卫）', s == 403, r)
    # 管理员直连 PATCH registration_field_defs.organization_id：机构归属禁改，守卫 403
    s, fd = call(base, 'POST', '/api/collections/registration_field_defs/records',
                 {'organization_id': org, 'field_code': 'hd_custom', 'field_type': 'text',
                  'label': '加固自定义', 'source_type': 'custom', 'is_sensitive': False,
                  'options_json': None, 'required_default': False, 'status': 'active'}, AT)
    assert s == 200, '创建自定义字段失败：%s' % fd
    s, r = call(base, 'PATCH', '/api/collections/registration_field_defs/records/%s' % fd['id'],
                {'organization_id': ''}, AT)
    rep.check('HG-08 管理员直连改字段机构归属 → 403（守卫）', s == 403, r)
    # 超管直连写 registrations 放行（运维/测试通道）：另选未报名参与者避免撞唯一索引
    P2, _, _ = fx.create_participant(base, 'hd_user2')
    s, r = call(base, 'POST', '/api/collections/registrations/records',
                {'activity_id': act, 'participant_id': P2, 'activity_role': 'listener',
                 'status': 'pending', 'submitted_at': '2026-08-09 00:00:00Z'}, st)
    rep.check('HG-09 超管直连创建报名放行 → 200', s == 200, r)

    # ---------- 2. 账号停用不可自助复活 ----------
    # 参与者：超管停用后，本人持原 token 直连改回 status → updateRule 先触发 404（守卫 403 兜底）
    s, r = call(base, 'PATCH', '/api/collections/participant_accounts/records/%s' % P1,
                {'status': 'disabled'}, st)
    assert s == 200, '停用参与者失败：%s' % r
    s, r = call(base, 'PATCH', '/api/collections/participant_accounts/records/%s' % P1,
                {'status': 'active'}, PT1)
    rep.check('HG-10 被停用参与者自改 status=active → 404/403（不可自助复活）',
              s in (403, 404), 'status=%s body=%s' % (s, r))
    s, r = call(base, 'PATCH', '/api/collections/participant_accounts/records/%s' % P1,
                {'status': 'active'}, st)
    assert s == 200, '恢复参与者失败：%s' % r
    # 管理员：同口径（超管停用 → 本人自改被拒 → 超管恢复）
    s, adm = call(base, 'GET', "/api/collections/admin_accounts/records?perPage=1&filter=(username='hd_admin')",
                  token=st)
    admin_id = (adm.get('items') or [{}])[0].get('id')
    s, r = call(base, 'PATCH', '/api/collections/admin_accounts/records/%s' % admin_id,
                {'status': 'disabled'}, st)
    assert s == 200, '停用管理员失败：%s' % r
    s, r = call(base, 'PATCH', '/api/collections/admin_accounts/records/%s' % admin_id,
                {'status': 'active'}, AT)
    rep.check('HG-11 被停用管理员自改 status=active → 404/403（不可自助复活）',
              s in (403, 404), 'status=%s body=%s' % (s, r))
    s, r = call(base, 'PATCH', '/api/collections/admin_accounts/records/%s' % admin_id,
                {'status': 'active'}, st)
    assert s == 200, '恢复管理员失败：%s' % r

    # ---------- 3. 内置认证限流（authguard.pb.js，AC-21 同语义）----------
    # ⚠️ 必须是本套件最后一个使用内置 auth-with-password 的段落（per-IP 预算见文件头）
    fx.create_participant(base, 'hd_rl_user')
    codes = []
    for _ in range(5):
        s, r = call(base, 'POST', '/api/collections/participant_accounts/auth-with-password',
                    {'identity': 'hd_rl_user', 'password': 'wrong_pass_999'})
        codes.append(s)
    rep.check('HG-20 内置端点前 5 次错误密码均 400', codes == [400] * 5, codes)
    s, r = call(base, 'POST', '/api/collections/participant_accounts/auth-with-password',
                {'identity': 'hd_rl_user', 'password': 'wrong_pass_999'})
    rep.check('HG-21 第 6 次触发限流 → 429 TOO_MANY_ATTEMPTS',
              s == 429 and biz_code(r) == 'TOO_MANY_ATTEMPTS', r)
    s, r = call(base, 'POST', '/api/collections/participant_accounts/auth-with-password',
                {'identity': 'hd_rl_user', 'password': fx.PASSWORD})
    rep.check('HG-22 限流期间正确密码同样被拒（429）',
              s == 429 and biz_code(r) == 'TOO_MANY_ATTEMPTS', r)

    # ---------- 4. CSV 公式注入中和（exports.pb.js csvCell）----------
    P3, PT3, _ = fx.create_participant(base, 'hd_user3')
    s, r = call(base, 'POST', '/api/cc/activities/%s/register' % act,
                {'activity_role': 'listener',
                 'answers': fx.with_full_name([{'field_def_id': fields['nickname'], 'value': '=1+1'}])}, PT3)
    reg3 = (r.get('registration') or {}).get('id')
    rep.check('HG-30 含公式开头答案的报名可正常提交（=1+1 为合法文本）', s == 200 and bool(reg3), r)
    s, exp = call(base, 'POST', '/api/cc/exports',
                  {'scope': {'type': 'organization'}, 'include_pii': False}, AT)
    job = (exp.get('export_job') or {}).get('id')
    rep.check('HG-31 创建导出任务', s == 200 and bool(job), exp if s != 200 else '')
    s, blob = call(base, 'GET', '/api/cc/exports/%s/download' % job, token=AT, raw=True)
    neutralized = False
    if s == 200 and isinstance(blob, bytes):
        zf = zipfile.ZipFile(io.BytesIO(blob))
        content = zf.read('registration_answers.csv').decode('utf-8-sig')
        rows = list(csv.reader(io.StringIO(content)))
        header = rows[0]
        val_idx = header.index('value')
        code_idx = header.index('field_code')
        cells = [row[val_idx] for row in rows[1:] if len(row) > val_idx and row[code_idx] == 'nickname']
        neutralized = "'=1+1" in cells and '=1+1' not in cells
    rep.check('HG-32 导出 CSV 公式开头单元格前置单引号中和', s == 200 and neutralized,
              'status=%s' % s)
    s, r = call(base, 'GET',
                f"/api/collections/audit_logs/records?perPage=1&filter=(action='export.download'%26%26target_id='{job}')",
                token=st)
    rep.check('HG-33 导出下载写 export.download 审计', s == 200 and len(r.get('items') or []) == 1, r)

    # ---------- 5. 答案校验 400 路径（draft 按 question_type 校验）----------
    # 问卷资格要求报名已通过（PRD §5.6 未签到不强制）：用已通过的 PT3 触发校验分支
    fx.transition(base, AT, reg3, 'approved')
    sv, sv_qr = fx.create_survey(base, AT, act, ver_id, '加固问卷')
    call(base, 'POST', '/api/cc/activity-surveys/%s/open' % sv, {}, AT)
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/draft' % sv,
                {'answers': [{'question_code': 'MOOD', 'value': 9}]}, PT3)
    rep.check('HG-34 scale_1_5 超范围答案 → 400 validation_failed',
              s == 400 and biz_code(r) == 'validation_failed', r)
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/draft' % sv,
                {'answers': [{'question_code': 'SAT', 'value': 'evil'}]}, PT3)
    rep.check('HG-35 单选非法选项值 → 400 validation_failed',
              s == 400 and biz_code(r) == 'validation_failed', r)
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/draft' % sv,
                {'answers': [{'question_code': 'NOTE', 'value': 'x' * 2001}]}, PT3)
    rep.check('HG-36 文本答案超 2000 字符 → 400 validation_failed',
              s == 400 and biz_code(r) == 'validation_failed', r)
    # scale_0_10 须 0~10 整数（与 scale_1_5 同口径）：模板无该题型，挂自定义题后走 draft 校验
    s, q = call(base, 'POST', '/api/collections/survey_questions/records',
                {'activity_survey_id': sv, 'question_code': 'NPS', 'source_type': 'custom',
                 'question_type': 'scale_0_10', 'title': '推荐意愿', 'required': False,
                 'order_index': 10}, AT)
    assert s == 200, '创建 scale_0_10 自定义题失败：%s' % q
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/draft' % sv,
                {'answers': [{'question_code': 'NPS', 'value': 1.5}]}, PT3)
    rep.check('HG-37 scale_0_10 非整数（1.5）→ 400 validation_failed',
              s == 400 and biz_code(r) == 'validation_failed', r)
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/draft' % sv,
                {'answers': [{'question_code': 'NPS', 'value': 100}]}, PT3)
    rep.check('HG-38 scale_0_10 超范围（100）→ 400 validation_failed',
              s == 400 and biz_code(r) == 'validation_failed', r)
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/draft' % sv,
                {'answers': [{'question_code': 'NPS', 'value': 7}]}, PT3)
    rep.check('HG-39 scale_0_10 合法整数（7）→ 草稿保存成功', s == 200, r)

    # ---------- 6. 签到二维码面 ----------
    s, r = call(base, 'GET', '/api/collections/activities/records/%s' % act)
    rep.check('HG-40 匿名原生 view 已发布活动 → 404（公开面收敛）', s == 404, r)
    s, r = call(base, 'GET', '/api/cc/public/activities/%s' % act)
    rep.check('HG-41 公开详情 200 且响应不含 checkin_qr_token（全 payload 无 token 值）',
              s == 200 and qr not in json.dumps(r), r if s != 200 else '')
    s, r = fx.self_checkin(base, 'ckqr_nonexistent_token', PT1)
    rep.check('HG-42 错误签到 token → 404 ACTIVITY_NOT_FOUND',
              s == 404 and biz_code(r) == 'ACTIVITY_NOT_FOUND', r)
    # 直连创建自带 checkin_qr_token：服务端无条件覆盖（防可预测 token 自建，FR-CHK-001）
    s, r = call(base, 'POST', '/api/collections/activities/records', {
        'organization_id': org, 'activity_code': 'CC_IT_HARD_04', 'title': '自带签到token活动',
        'description': 'x', 'location': '线上',
        'start_time': '2026-08-10 12:00:00Z', 'end_time': '2026-08-10 14:00:00Z',
        'status': 'draft', 'capacity_total': 10, 'capacity_speaker': 5,
        'capacity_listener': 5, 'registration_open': True,
        'registration_start_at': '2026-08-01 00:00:00Z',
        'registration_end_at': '2026-12-31 23:59:59Z', 'group_tag': '',
        'form_config_json': {'fields': []}, 'checkin_qr_token': 'weak'}, AT)
    tok = r.get('checkin_qr_token') or ''
    rep.check('HG-43 直连创建自带 checkin_qr_token=weak → 服务端覆盖为 24 位随机串',
              s == 200 and len(tok) == 24 and tok != 'weak', r)

    # ---------- 7. 活动状态机补强 ----------
    # 下架活动审核报名 → 400 ACTIVITY_UNAVAILABLE（approve/reject 均拒绝，此处验 approve）
    s, r = call(base, 'POST', '/api/cc/activities/%s/unpublish' % act, {'reason': '安全下架演练'}, st)
    rep.check('HG-50 超管下架活动（前置）', s == 200, r)
    s, r = fx.transition(base, AT, reg1, 'approved')
    rep.check('HG-51 已下架活动审核报名 → 400 ACTIVITY_UNAVAILABLE',
              s == 400 and biz_code(r) == 'ACTIVITY_UNAVAILABLE', r)
    # 草稿活动开放签到 → 400 ACTIVITY_NOT_OPEN
    act_draft = fx.create_activity(base, AT, org, 'CC_IT_HARD_03', '加固草稿场',
                                   fields=fx.nick_field_cfg(fields), publish=False)
    s, r = call(base, 'POST', '/api/cc/activities/%s/checkin/open' % act_draft, {}, AT)
    rep.check('HG-52 草稿活动开放签到 → 400 ACTIVITY_NOT_OPEN',
              s == 400 and biz_code(r) == 'ACTIVITY_NOT_OPEN', r)
