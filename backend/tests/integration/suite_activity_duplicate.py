# -*- coding: utf-8 -*-
"""suite_activity_duplicate — T4 复制活动端点（POST /api/cc/activities/{id}/duplicate）。

PRD §4.1：复制时必须重新生成活动代码、签到 token、问卷入口 token，不复制历史报名、
签到、配对、答卷和审计记录；新活动恒为草稿、问卷恒重置为草稿。
越权口径（api-design §2.1）：跨机构与不存在统一 404，参与者/匿名拒绝。
"""
from urllib.parse import quote

import cc_fixture as fx
from cc_client import biz_code, call


def _list(base, token, collection, flt=''):
    query = '?perPage=200'
    if flt:
        query += '&filter=' + quote(flt, safe="'()")
    status, body = call(base, 'GET', '/api/collections/%s/records%s' % (collection, query),
                        token=token)
    return status, body.get('items') or []


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    rep.section('suite_activity_duplicate：T4 复制活动')

    org = fx.create_org(base, st, 'T4 复制机构')
    _, admin_token = fx.create_admin_via_impersonate(base, st, org, 't4_dup_admin')
    other_org = fx.create_org(base, st, 'T4 复制其他机构')
    _, other_admin = fx.create_admin_via_impersonate(base, st, other_org, 't4_dup_other_admin')

    # 源活动：nickname（平台标准字段）启用必填 + 本机构自定义字段，验证报名表配置随复制保留
    s, custom_field = call(base, 'POST', '/api/collections/registration_field_defs/records', {
        'organization_id': org, 'field_code': 't4_dup_note', 'field_type': 'text',
        'label': '备注', 'source_type': 'custom', 'is_sensitive': False,
        'options_json': None, 'required_default': False, 'status': 'active'}, admin_token)
    assert s == 200, '创建 T4 自定义字段失败：%s' % custom_field
    source = fx.create_activity(
        base, admin_token, org, 'CC_IT_T4_DUP', 'T4 复制源活动',
        fields=[(ctx['fields']['nickname'], True, True), (custom_field['id'], True, False)],
        caps=(10, 5, 5))
    s, source_record = call(base, 'GET', '/api/collections/activities/records/%s' % source,
                            token=admin_token)
    assert s == 200, '读取源活动失败：%s' % source_record

    # 源活动挂上问卷（开放中）、报名/签到/答卷历史——这些都不应被复制
    survey_id, source_qr = fx.create_survey(base, admin_token, source, ctx['ver_id'],
                                            'T4 源问卷', 'both')
    call(base, 'POST', '/api/cc/activity-surveys/%s/open' % survey_id, {}, admin_token)
    participant_id, participant_token, _ = fx.create_participant(base, 't4_dup_u1')
    registration_id = fx.register(base, participant_token, source, 'speaker', [
        {'field_def_id': ctx['fields']['nickname'], 'value': 't4_dup_u1'}])
    fx.transition(base, admin_token, registration_id, 'approved')
    call(base, 'POST', '/api/cc/activities/%s/checkin/open' % source, {}, admin_token)
    s, checkin_body = fx.self_checkin(base, fx.checkin_token(base, admin_token, source),
                                      participant_token)
    assert s == 200, 'T4 fixture 签到失败：%s' % checkin_body
    s, submission = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % survey_id, {
        'answers': [{'question_code': 'MOOD', 'value': 4},
                    {'question_code': 'SAT', 'value': 'good'}]}, participant_token)
    assert s == 200, 'T4 fixture 提交答卷失败：%s' % submission
    # 源活动确实已有历史数据（作为「不得复制」的对照）
    _, source_regs = _list(base, admin_token, 'registrations', "activity_id='%s'" % source)
    _, source_checkins = _list(base, admin_token, 'checkins', "activity_id='%s'" % source)
    assert len(source_regs) == 1 and len(source_checkins) == 1, 'T4 fixture 历史数据不完整'

    s, dup = call(base, 'POST', '/api/cc/activities/%s/duplicate' % source, {}, admin_token)
    copy = dup.get('activity') or {}
    rep.check('DUP-01 复制成功且带冻结契约版本',
              s == 200 and dup.get('contract_version') == '2026-08-28.t0-v1'
              and copy.get('id') and copy['id'] != source, dup)
    rep.check('DUP-02 重新生成活动代码且配置字段完整复制',
              copy.get('activity_code') == 'CC_IT_T4_DUP_CP1'
              and copy.get('title') == 'T4 复制源活动（副本）'
              and copy.get('organization_id') == org
              and copy.get('capacity_total') == 10
              and copy.get('capacity_speaker') == 5
              and copy.get('capacity_listener') == 5
              and copy.get('start_time') == source_record.get('start_time')
              and copy.get('end_time') == source_record.get('end_time')
              and copy.get('registration_open') is True, copy)
    form_config = copy.get('form_config_json') or {}
    rep.check('DUP-03 报名表配置（form_config_json）随复制保留',
              isinstance(form_config, dict)
              and len(form_config.get('fields') or []) == 3
              and any(f.get('field_def_id') == custom_field['id']
                      for f in form_config.get('fields') or []), form_config)
    rep.check('DUP-04 签到 token 重新生成、现场编号/配对状态重置、恒为草稿',
              copy.get('status') == 'draft'
              and copy.get('checkin_qr_token')
              and copy.get('checkin_qr_token') != source_record.get('checkin_qr_token')
              and copy.get('next_speaker_sequence') == 1
              and copy.get('next_listener_sequence') == 1
              and not copy.get('pairing_started_at') and not copy.get('pairing_started_by')
              and not copy.get('onsite_locked_at') and not copy.get('onsite_locked_by'), copy)

    copy_id = copy.get('id')
    _, copy_surveys = _list(base, admin_token, 'activity_surveys', "activity_id='%s'" % copy_id)
    rep.check('DUP-05 问卷随复制但状态重置为草稿、入口 token 重新生成',
              len(copy_surveys) == 1
              and copy_surveys[0].get('title') == 'T4 源问卷'
              and copy_surveys[0].get('role_scope') == 'both'
              and copy_surveys[0].get('status') == 'draft'
              and copy_surveys[0].get('qr_token')
              and copy_surveys[0].get('qr_token') != source_qr
              and str(copy_surveys[0].get('survey_code') or '').startswith('CC_IT_T4_DUP_CP1_S')
              and not copy_surveys[0].get('opened_at') and not copy_surveys[0].get('ended_at'),
              copy_surveys)
    _, copy_questions = _list(base, admin_token, 'survey_questions',
                              "activity_survey_id='%s'" % (copy_surveys[0]['id'] if copy_surveys else 'none'))
    rep.check('DUP-06 问卷题目物化行随复制（模板 3 题）',
              len(copy_questions) == 3
              and sorted(q.get('question_code') for q in copy_questions) == ['MOOD', 'NOTE', 'SAT'],
              copy_questions)

    _, copy_regs = _list(base, admin_token, 'registrations', "activity_id='%s'" % copy_id)
    _, copy_checkins = _list(base, admin_token, 'checkins', "activity_id='%s'" % copy_id)
    _, copy_pairs = _list(base, admin_token, 'activity_pairs', "activity_id='%s'" % copy_id)
    _, copy_submissions = _list(base, admin_token, 'submissions',
                                "activity_survey_id.activity_id='%s'" % copy_id)
    _, copy_sessions = _list(base, admin_token, 'checkin_sessions', "activity_id='%s'" % copy_id)
    rep.check('DUP-07 不复制历史报名、签到、配对、答卷与签到场次',
              not copy_regs and not copy_checkins and not copy_pairs
              and not copy_submissions and not copy_sessions,
              [copy_regs, copy_checkins, copy_pairs, copy_submissions, copy_sessions])

    _, audits = _list(base, admin_token, 'audit_logs',
                      "action='activity.duplicate' && target_id='%s'" % copy_id)
    rep.check('DUP-08 复制写入审计（来源活动与问卷数入 metadata）',
              len(audits) == 1
              and (audits[0].get('metadata') or {}).get('source_activity_id') == source
              and (audits[0].get('metadata') or {}).get('duplicated_surveys') == 1, audits)

    # 重复复制：活动代码继续递增，不与首个副本冲突
    s, dup2 = call(base, 'POST', '/api/cc/activities/%s/duplicate' % source, {}, admin_token)
    rep.check('DUP-09 再次复制分配递增唯一代码',
              s == 200 and (dup2.get('activity') or {}).get('activity_code') == 'CC_IT_T4_DUP_CP2',
              dup2)

    # 越权与匿名口径（api-design §2.1：跨机构 = 不存在 = 404；参与者 403；匿名 401）
    s, cross = call(base, 'POST', '/api/cc/activities/%s/duplicate' % source, {}, other_admin)
    rep.check('DUP-10 跨机构复制返回 404 not_found',
              s == 404 and biz_code(cross) == 'ACTIVITY_NOT_FOUND', cross)
    s, missing = call(base, 'POST', '/api/cc/activities/nonexistent000/duplicate', {}, admin_token)
    rep.check('DUP-11 复制不存在的活动返回 404',
              s == 404 and biz_code(missing) == 'ACTIVITY_NOT_FOUND', missing)
    s, participant_denied = call(base, 'POST', '/api/cc/activities/%s/duplicate' % source, {},
                                 participant_token)
    rep.check('DUP-12 参与者复制返回 403', s == 403, participant_denied)
    s, anon_denied = call(base, 'POST', '/api/cc/activities/%s/duplicate' % source, {})
    rep.check('DUP-13 匿名复制返回 401', s == 401, anon_denied)
