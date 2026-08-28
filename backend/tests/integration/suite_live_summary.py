# -*- coding: utf-8 -*-
"""suite_live_summary — T3 单活动快照、双完成率、抑制与 Realtime topic 权限。"""
import urllib.request

import cc_fixture as fx
from cc_client import call


_NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _create_field(base, token, org_id, code, label, field_type='text'):
    status, body = call(base, 'POST', '/api/collections/registration_field_defs/records', {
        'organization_id': org_id,
        'field_code': code,
        'field_type': field_type,
        'label': label,
        'source_type': 'custom',
        'is_sensitive': code == 'FULL_NAME',
        'options_json': None,
        'required_default': code == 'FULL_NAME',
        'status': 'active',
    }, token)
    assert status == 200, '创建 T3 fixture 字段失败：%s' % body
    return body['id']


def _submit(base, survey_id, participant_token, mood=4):
    status, body = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % survey_id, {
        'answers': [
            {'question_code': 'MOOD', 'value': mood},
            {'question_code': 'SAT', 'value': 'good'},
        ],
    }, participant_token)
    assert status == 200, 'T3 fixture 提交答卷失败：%s' % body
    return body['submission']['id']


def _realtime_client_id(base):
    stream = _NO_PROXY.open(base + '/api/realtime', timeout=5)
    client_id = ''
    for _ in range(12):
        line = stream.readline().decode('utf-8', 'replace').strip()
        if line.startswith('id:'):
            client_id = line.split(':', 1)[1].strip()
        if client_id and line == '':
            break
    assert client_id, '未收到 PocketBase PB_CONNECT client id'
    return stream, client_id


def _survey(summary, survey_id):
    return next((item for item in summary.get('surveys') or []
                 if item.get('activity_survey_id') == survey_id), {})


def _bucket(summary, dimension, key):
    return next((item for item in (summary.get('demographics') or {}).get(dimension, [])
                 if item.get('key') == key), {})


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    ver_id = ctx['ver_id']
    rep.section('suite_live_summary：T3 实时快照与 Realtime 权限')

    org = fx.create_org(base, st, 'T3 实时快照机构')
    _, admin_token = fx.create_admin_via_impersonate(base, st, org, 't3_live_admin')
    full_name = _create_field(base, admin_token, org, 'FULL_NAME', '姓名')
    gender = _create_field(base, admin_token, org, 'GENDER', '性别', 'single_choice')
    age_range = _create_field(base, admin_token, org, 'AGE_RANGE', '年龄段', 'single_choice')
    fields = [
        (ctx['fields']['nickname'], False, False),
        (full_name, True, True),
        (gender, True, False),
        (age_range, True, False),
    ]
    activity = fx.create_activity(base, admin_token, org, 'CC_IT_T3_LIVE', 'T3 快照场',
                                  fields=fields, caps=(12, 6, 6))

    participants = []
    registrations = []
    for index in range(6):
        participant_id, participant_token, _ = fx.create_participant(base, 't3_live_u%d' % index)
        answers = [
            {'field_def_id': full_name, 'value': '快照参与者%d' % index},
            {'field_def_id': gender, 'value': 'female' if index < 5 else 'male'},
            {'field_def_id': age_range, 'value': '25_34'},
        ]
        registration_id = fx.register(base, participant_token, activity, 'speaker', answers)
        status, _ = fx.transition(base, admin_token, registration_id, 'approved')
        assert status == 200, 'T3 fixture 审核失败'
        participants.append((participant_id, participant_token))
        registrations.append(registration_id)

    survey, _ = fx.create_survey(base, admin_token, activity, ver_id, 'T3 全员问卷', 'both')
    empty_survey, _ = fx.create_survey(base, admin_token, activity, ver_id, 'T3 聆听者问卷', 'listener')
    call(base, 'POST', '/api/cc/activity-surveys/%s/open' % survey, {}, admin_token)
    call(base, 'POST', '/api/cc/activity-surveys/%s/open' % empty_survey, {}, admin_token)

    call(base, 'POST', '/api/cc/activities/%s/checkin/open' % activity, {}, admin_token)
    checkins = []
    token = fx.checkin_token(base, admin_token, activity)
    for _, participant_token in participants[:5]:
        status, body = fx.self_checkin(base, token, participant_token)
        assert status == 200, 'T3 fixture 签到失败：%s' % body
        checkins.append(body['checkin']['id'])
    call(base, 'POST', '/api/cc/activities/%s/checkin/close' % activity, {}, admin_token)

    submissions = []
    for _, participant_token in participants[:4]:
        submissions.append(_submit(base, survey, participant_token))
    submissions.append(_submit(base, survey, participants[5][1]))

    status, initial = call(base, 'GET', '/api/cc/activities/%s/live-summary' % activity,
                           token=admin_token)
    metric = _survey(initial, survey)
    empty_metric = _survey(initial, empty_survey)
    rep.check('T3-01 快照返回冻结版本、报名漏斗与有效签到',
              status == 200
              and initial.get('contract_version') == '2026-08-28.t0-v1'
              and (initial.get('registrations') or {}).get('approved', {}).get('total') == 6
              and (initial.get('checkins') or {}).get('valid', {}).get('total') == 5, initial)
    rep.check('T3-02 现场/总体完成率分别使用 valid 与 approved 当前交集',
              metric.get('onsite_completion') == {'eligible': 5, 'submitted': 4, 'rate': 0.8}
              and metric.get('overall_completion', {}).get('eligible') == 6
              and metric.get('overall_completion', {}).get('submitted') == 5
              and abs(metric.get('overall_completion', {}).get('rate', 0) - 5 / 6) < 1e-9,
              metric)
    rep.check('T3-03 分母为 0 返回 rate=null',
              empty_metric.get('onsite_completion') == {'eligible': 0, 'submitted': 0, 'rate': None}
              and empty_metric.get('overall_completion') == {'eligible': 0, 'submitted': 0, 'rate': None},
              empty_metric)
    rep.check('T3-04 小于 5 的 demographic 桶隐藏计数，达到 5 的桶可见',
              _bucket(initial, 'gender', 'female') == {
                  'key': 'female', 'count': 5, 'suppressed': False}
              and _bucket(initial, 'gender', 'male') == {
                  'key': 'male', 'count': None, 'suppressed': True},
              (initial.get('demographics') or {}).get('gender'))
    rep.check('T3-05 最近签到仅下发该场 FULL_NAME，T2 未合入时配对指标兼容为 0',
              len(initial.get('recent_checkins') or []) == 5
              and all(item.get('display_name', '').startswith('快照参与者')
                      for item in initial.get('recent_checkins') or [])
              and (initial.get('pairings') or {}).get('active_pairs') == 0,
              {'recent': initial.get('recent_checkins'), 'pairings': initial.get('pairings')})

    call(base, 'POST', '/api/cc/checkins/%s/revoke' % checkins[0], {'reason': 'T3 撤销回归'}, admin_token)
    fx.transition(base, admin_token, registrations[5], 'cancelled', reason='T3 回退报名')
    call(base, 'POST', '/api/cc/submissions/%s/void' % submissions[1],
         {'reason': 'T3 作废回归'}, admin_token)
    status, changed = call(base, 'GET', '/api/cc/activities/%s/live-summary' % activity,
                           token=admin_token)
    changed_metric = _survey(changed, survey)
    rep.check('T3-06 撤销签到同时移出现场分子/分母，完成率不超过 1',
              status == 200
              and changed_metric.get('onsite_completion') == {
                  'eligible': 4, 'submitted': 2, 'rate': 0.5}, changed_metric)
    rep.check('T3-07 回退报名与作废答卷按当前总体资格交集重算',
              changed_metric.get('overall_completion') == {
                  'eligible': 5, 'submitted': 3, 'rate': 0.6}, changed_metric)

    other_org = fx.create_org(base, st, 'T3 越权机构')
    _, other_admin = fx.create_admin_via_impersonate(base, st, other_org, 't3_live_other')
    status, body = call(base, 'GET', '/api/cc/activities/%s/live-summary' % activity,
                        token=other_admin)
    rep.check('T3-08 跨机构快照与不存在统一返回 404 not_found',
              status == 404 and (body.get('data') or {}).get('code') == 'not_found', body)
    status, super_summary = call(base, 'GET', '/api/cc/activities/%s/live-summary' % activity,
                                 token=st)
    rep.check('T3-09 超管可读取单活动快照',
              status == 200 and super_summary.get('activity_id') == activity, super_summary)
    status, _ = call(base, 'GET', '/api/cc/activities/%s/live-summary' % activity,
                     token=participants[0][1])
    rep.check('T3-10 participant 不能调用管理端快照', status in (401, 403), status)

    stream = None
    try:
        stream, client_id = _realtime_client_id(base)
        own_topic = 'cc.participant.pairing.%s' % participants[0][0]
        status, body = call(base, 'POST', '/api/realtime', {
            'clientId': client_id, 'subscriptions': [own_topic]}, participants[0][1])
        rep.check('T3-11 participant 可订阅本人 pairing topic', status == 204, body)
        status, body = call(base, 'POST', '/api/realtime', {
            'clientId': client_id,
            'subscriptions': ['cc.participant.pairing.%s' % participants[1][0]],
        }, participants[0][1])
        rep.check('T3-12 participant 伪造他人 pairing topic 被拒', status == 403, body)
        status, body = call(base, 'POST', '/api/realtime', {
            'clientId': client_id, 'subscriptions': ['activity_pairs/*']}, participants[0][1])
        rep.check('T3-13 participant 直订 activity_pairs 被拒', status == 403, body)
    finally:
        if stream is not None:
            stream.close()
