# -*- coding: utf-8 -*-
"""2026-09-24 post-session questionnaire catalogue and immutable versions."""
import json
import urllib.parse

import cc_fixture as fx
from cc_client import biz_code, call


def _records(base, token, collection, expression):
    path = '/api/collections/%s/records?perPage=200&filter=%s' % (
        collection, urllib.parse.quote(expression, safe=''))
    status, response = call(base, 'GET', path, token=token)
    return status, response.get('items') or [], response


def _schema(base, token, version_id):
    status, response = call(
        base, 'GET', '/api/collections/survey_template_versions/records/%s' % version_id,
        token=token)
    schema = response.get('schema_json') or {}
    if isinstance(schema, str):
        schema = json.loads(schema)
    return status, schema, response


def _option_values(question):
    return [option.get('value') for option in
            ((question.get('options_json') or {}).get('options') or [])]


def _required_answers(questions, *, chatter_next=None, include_other=False):
    answers = []
    for question in questions:
        code = question['question_code']
        if not question.get('required') or (code == 'CPOST_Q21_OTHER' and not include_other):
            continue
        qtype = question['question_type']
        if code == 'CPOST_Q21':
            value = chatter_next or ['nothing_for_now']
        elif code == 'CPOST_Q21_OTHER':
            value = '希望了解社区艺术活动'
        elif code == 'LPOST_Q10':
            value = 'C07'
        elif qtype == 'single_choice':
            value = _option_values(question)[0]
        elif qtype == 'multi_choice':
            value = [_option_values(question)[0]]
        elif qtype == 'scale_1_5':
            value = 4
        elif qtype == 'scale_0_10':
            value = 7
        else:
            value = '集成测试回答'
        answers.append({'question_code': code, 'value': value})
    return answers


def run_post_survey_checks(ctx):
    """Check seeded API records, rather than importing the migration's own data."""
    base, token, rep = ctx['base'], ctx['st'], ctx['rep']
    rep.section('suite_four_forms：2026-09-24 后测模板')

    code_filter = "template_code = 'CHATTER_POST_20260924' || template_code = 'LISTENER_POST_20260924'"
    status, items, body = _records(base, token, 'survey_templates', code_filter)
    by_code = {item.get('template_code'): item for item in items}
    rep.check('FOUR-POST-01 两份后测模板均生效且角色正确',
              status == 200 and len(items) == 2
              and by_code.get('CHATTER_POST_20260924', {}).get('status') == 'active'
              and by_code.get('CHATTER_POST_20260924', {}).get('kind') == 'survey'
              and by_code.get('CHATTER_POST_20260924', {}).get('role_scope') == 'speaker'
              and by_code.get('LISTENER_POST_20260924', {}).get('status') == 'active'
              and by_code.get('LISTENER_POST_20260924', {}).get('kind') == 'survey'
              and by_code.get('LISTENER_POST_20260924', {}).get('role_scope') == 'listener', body)

    if len(items) != 2:
        return
    chatter = by_code['CHATTER_POST_20260924']
    listener = by_code['LISTENER_POST_20260924']
    cs, c_schema, c_body = _schema(base, token, chatter['current_version_id'])
    ls, l_schema, l_body = _schema(base, token, listener['current_version_id'])
    cq = c_schema.get('questions') or []
    lq = l_schema.get('questions') or []
    chatter_codes = ['CPOST_Q%02d' % n for n in range(1, 22)] + [
        'CPOST_Q21_OTHER', 'CPOST_Q22', 'CPOST_Q23']
    rep.check('FOUR-POST-02 Chatter 为原文 23 题及一项“其他”补充输入',
              cs == 200 and len(cq) == 24 and
              [q.get('question_code') for q in cq] == chatter_codes and
              [q.get('order_index') for q in cq] == list(range(24)), c_body)
    rep.check('FOUR-POST-03 Listener 首版为原文 19 题，题号完整且顺序固定',
              ls == 200 and len(lq) == 19 and
              [q.get('question_code') for q in lq] ==
              ['LPOST_Q%02d' % n for n in range(1, 20)] and
              [q.get('order_index') for q in lq] == list(range(19)), l_body)
    if len(cq) != 24 or len(lq) != 19:
        return

    rep.check('FOUR-POST-04 Chatter MCCY 量表与资源三分类保留双语',
              all(q.get('question_type') == 'scale_1_5' and '\n' in q.get('title', '')
                  and q.get('required') for q in cq[:10])
              and _option_values(cq[10]) == ['yes', 'unsure', 'no']
              and '知道' in cq[10]['options_json']['options'][0]['label']
              and cq[10].get('required'), cq[:11])
    rep.check('FOUR-POST-05 Chatter 压力变化五类、现时压力 0–10、下一步多选',
              _option_values(cq[11]) ==
              ['much_lower', 'slightly_lower', 'same', 'slightly_higher', 'much_higher']
              and cq[12].get('question_type') == 'scale_0_10'
              and cq[12].get('validation_json', {}).get('max') == 10
              and cq[20].get('question_type') == 'multi_choice'
              and len(_option_values(cq[20])) == 6, [cq[11], cq[12], cq[20]])
    rep.check('FOUR-POST-06 Chatter “其他”条件必填，末两题选填，无重复本人 Tag',
              [q.get('question_code') for q in cq if not q.get('required')] ==
              ['CPOST_Q22', 'CPOST_Q23']
              and cq[21].get('required') is True
              and cq[21].get('validation_json', {}).get('show_when') ==
              {'question_code': 'CPOST_Q21', 'value': 'other'}
              and cq[20].get('validation_json', {}).get('exclusive_values') ==
              ['nothing_for_now']
              and not any('Chatter Tag' in q.get('title', '') for q in cq), cq)

    rep.check('FOUR-POST-07 Listener MCCY 成效题维持指定题型与选项',
              lq[0].get('question_type') == 'scale_1_5'
              and _option_values(lq[1]) ==
              ['much_better', 'slightly_better', 'same', 'slightly_worse', 'much_worse']
              and _option_values(lq[2]) ==
              ['yes_definitely', 'maybe', 'not_particularly', 'no']
              and lq[3].get('question_type') == 'scale_1_5'
              and '非常充实' in lq[3].get('validation_json', {}).get('labels', {}).get('5', ''), lq[:4])
    rep.check('FOUR-POST-08 Listener C1–C4 仅活动后自信状态量表',
              all(q.get('question_type') == 'scale_1_5'
                  and q.get('validation_json', {}).get('max') == 5
                  and q.get('required') for q in lq[4:8]), lq[4:8])
    rep.check('FOUR-POST-09 Listener 搭档编号格式、支持标记、NPS 与选填结尾',
              lq[9].get('question_type') == 'text_short'
              and lq[9].get('validation_json', {}).get('pattern') == '^C[0-9]+$'
              and _option_values(lq[10]) == ['yes', 'no']
              and lq[11].get('question_type') == 'scale_0_10'
              and lq[11].get('validation_json', {}).get('max') == 10
              and [q.get('question_code') for q in lq if not q.get('required')] ==
              ['LPOST_Q19'], [lq[9], lq[10], lq[11], lq[18]])

    # The integration runner injects one active legacy fixture after migrations
    # so earlier suites can test survey versioning. It is intentionally exempted.
    status, active, body = _records(base, token, 'survey_templates',
                                    "status = 'active' && kind = 'survey'")
    unexpected = [t.get('template_code') for t in active if
                  t.get('template_code') not in {
                      'CHATTER_POST_20260924', 'LISTENER_POST_20260924',
                      'PARTICIPANT_POST_V1',
                  } and not (t.get('template_code') or '').startswith('TPL_')]
    rep.check('FOUR-POST-10 其他旧后测模板从可选目录停用，历史版本仍可读取',
              status == 200 and not unexpected, {'unexpected': unexpected, 'body': body})

    # Real admin and participant routes: copy, eligibility, draft, submit and
    # read-back. Each survey has its own immutable question snapshot.
    org = fx.create_org(base, token, '四表后测机构')
    _, admin_token = fx.create_admin_via_impersonate(base, token, org, 'four_post_admin')
    _, all_fields = call(base, 'GET',
                         '/api/collections/registration_field_defs/records?perPage=200', token=token)
    inactive_new_fields = [(item['id'], False, False) for item in all_fields.get('items') or []
                           if (item.get('field_code') or '').startswith(('C24_', 'L24_'))]
    activity = fx.create_activity(base, admin_token, org, 'CC_IT_FOUR_POST', '四表后测场',
                                  fields=fx.nick_field_cfg(ctx['fields']) + inactive_new_fields,
                                  caps=(8, 4, 4))
    _, speaker_token, _ = fx.create_participant(base, 'four_post_chatter')
    _, listener_token, _ = fx.create_participant(base, 'four_post_listener')
    speaker_reg = fx.register(base, speaker_token, activity, 'speaker',
                              fx.field_answers(ctx['fields'], '后测倾诉者'))
    listener_reg = fx.register(base, listener_token, activity, 'listener',
                               fx.field_answers(ctx['fields'], '后测倾听者'))
    fx.transition(base, admin_token, speaker_reg, 'approved')
    fx.transition(base, admin_token, listener_reg, 'approved')
    survey_route = '/api/cc/activities/%s/surveys' % activity

    s, r = call(base, 'POST', survey_route, {
        'template_version_id': chatter['current_version_id'], 'title': 'Chatter 后测',
        'role_scope': 'listener', 'phase': 'before'}, admin_token)
    rep.check('FOUR-POST-11 Chatter 模板不能创建 Listener 问卷',
              s == 400 and biz_code(r) == 'validation_failed', r)
    s, r = call(base, 'POST', survey_route, {
        'template_version_id': listener['current_version_id'], 'title': 'Listener 后测',
        'role_scope': 'both', 'phase': 'onsite'}, admin_token)
    rep.check('FOUR-POST-12 Listener 模板不能创建双角色问卷',
              s == 400 and biz_code(r) == 'validation_failed', r)

    _, registration_templates, _ = _records(
        base, token, 'survey_templates', "template_code = 'CHATTER_REGISTRATION_20260929'")
    if registration_templates:
        s, r = call(base, 'POST', survey_route, {
            'template_version_id': registration_templates[0]['current_version_id'],
            'title': '误选报名表', 'role_scope': 'speaker'}, admin_token)
        rep.check('FOUR-POST-13 报名模板不得复制为活动问卷',
                  s == 400 and biz_code(r) == 'validation_failed', r)
    else:
        rep.check('FOUR-POST-13 报名模板已播种', False, registration_templates)

    s, r = call(base, 'POST', '/api/cc/super/templates', {
        'template_code': 'FOUR_POST_DISABLED_IT', 'name': '停用测试模板',
        'schema_json': {'questions': [
            {'question_code': 'TEST', 'question_type': 'text_short', 'title': '测试题'}]},
    }, token)
    disabled_id = (r.get('template') or {}).get('id')
    disabled_version = (r.get('version') or {}).get('id')
    rep.check('FOUR-POST-14 创建独立停用测试模板', s == 200 and bool(disabled_id), r)
    if disabled_id and disabled_version:
        s, r = call(base, 'PATCH',
                    '/api/collections/survey_templates/records/%s' % disabled_id,
                    {'status': 'disabled'}, token)
        assert s == 200, r
        s, r = call(base, 'POST', survey_route, {
            'template_version_id': disabled_version, 'title': '停用模板问卷',
            'role_scope': 'both'}, admin_token)
        rep.check('FOUR-POST-15 停用模板不得复制为活动问卷',
                  s == 400 and biz_code(r) == 'validation_failed', r)

    s, r = call(base, 'POST', survey_route, {
        'template_version_id': chatter['current_version_id'], 'title': 'Chatter 后测',
        'role_scope': 'speaker', 'phase': 'before'}, admin_token)
    chatter_survey = (r.get('survey') or {}).get('id')
    rep.check('FOUR-POST-16 正式 Chatter 问卷复制 24 行且强制 after 阶段',
              s == 200 and r.get('questions_copied') == 24
              and (r.get('survey') or {}).get('phase') == 'after'
              and bool(chatter_survey), r)
    s, r = call(base, 'POST', survey_route, {
        'template_version_id': listener['current_version_id'], 'title': 'Listener 后测',
        'role_scope': 'listener', 'phase': 'before'}, admin_token)
    listener_survey = (r.get('survey') or {}).get('id')
    rep.check('FOUR-POST-17 正式 Listener 问卷复制 19 行且强制 after 阶段',
              s == 200 and r.get('questions_copied') == 19
              and (r.get('survey') or {}).get('phase') == 'after'
              and bool(listener_survey), r)
    s, r = call(base, 'POST', survey_route, {
        'template_version_id': ctx['ver_id'], 'title': '既有版本验证',
        'role_scope': 'both', 'phase': 'onsite'}, admin_token)
    rep.check('FOUR-POST-18 旧版活动问卷仍可由其版本复制原有三题',
              s == 200 and r.get('questions_copied') == 3
              and (r.get('survey') or {}).get('phase') == 'onsite', r)
    if not chatter_survey or not listener_survey:
        return
    for sid in (chatter_survey, listener_survey):
        s, opened = call(base, 'POST', '/api/cc/activity-surveys/%s/open' % sid,
                         {}, admin_token)
        assert s == 200, opened

    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/draft' % listener_survey,
                {'answers': [{'question_code': 'LPOST_Q10', 'value': 'Alice'}]}, listener_token)
    rep.check('FOUR-POST-19 Listener 草稿拒绝姓名替代 Chatter 编号',
              s == 400 and biz_code(r) == 'validation_failed', r)
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/draft' % listener_survey,
                {'answers': [{'question_code': 'LPOST_Q10', 'value': 'C07'}]}, listener_token)
    rep.check('FOUR-POST-20 Listener 草稿接受 C+数字编号',
              s == 200 and (r.get('submission') or {}).get('status') == 'draft', r)
    full_listener = _required_answers(lq)
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % listener_survey,
                {'answers': [dict(a, value='机构名称') if a['question_code'] == 'LPOST_Q10' else a
                             for a in full_listener]}, listener_token)
    rep.check('FOUR-POST-21 Listener 正式提交也拒绝非 C+数字编号',
              s == 400 and biz_code(r) == 'validation_failed', r)
    s, r = call(base, 'POST', '/api/cc/activity-surveys/%s/submit' % listener_survey,
                {'answers': full_listener}, listener_token)
    rep.check('FOUR-POST-22 Listener 完整正式提交成功',
              s == 200 and (r.get('submission') or {}).get('status') == 'submitted', r)

    draft_route = '/api/cc/activity-surveys/%s/draft' % chatter_survey
    submit_route = '/api/cc/activity-surveys/%s/submit' % chatter_survey
    s, r = call(base, 'POST', draft_route, {'answers': [
        {'question_code': 'CPOST_Q21', 'value': ['other']},
        {'question_code': 'CPOST_Q21_OTHER', 'value': '想参加社区活动'},
    ]}, speaker_token)
    rep.check('FOUR-POST-23 Chatter 草稿可填写“其他”说明',
              s == 200 and any(a.get('question_code') == 'CPOST_Q21_OTHER'
                               for a in (r.get('submission') or {}).get('answers') or []), r)
    s, r = call(base, 'POST', draft_route, {'answers': [
        {'question_code': 'CPOST_Q21', 'value': ['nothing_for_now']},
        {'question_code': 'CPOST_Q21_OTHER', 'value': '隐藏内容不应保留'},
    ]}, speaker_token)
    rep.check('FOUR-POST-24 改选“暂时没有”后草稿清除隐藏说明',
              s == 200 and not any(a.get('question_code') == 'CPOST_Q21_OTHER'
                                   for a in (r.get('submission') or {}).get('answers') or []), r)
    s, r = call(base, 'POST', draft_route, {'answers': [
        {'question_code': 'CPOST_Q21', 'value': ['nothing_for_now', 'community_activities']},
    ]}, speaker_token)
    rep.check('FOUR-POST-25 “暂时没有”不能与其他下一步并选',
              s == 400 and biz_code(r) == 'validation_failed', r)
    chatter_answers = _required_answers(cq, chatter_next=['other'])
    s, r = call(base, 'POST', submit_route, {'answers': chatter_answers}, speaker_token)
    rep.check('FOUR-POST-26 选择“其他”但缺说明时提交被拒',
              s == 400 and biz_code(r) == 'validation_failed', r)
    chatter_answers = _required_answers(cq, chatter_next=['other'], include_other=True)
    s, r = call(base, 'POST', submit_route, {'answers': chatter_answers}, speaker_token)
    rep.check('FOUR-POST-27 补说明后 Chatter 完整提交成功',
              s == 200 and (r.get('submission') or {}).get('status') == 'submitted'
              and any(a.get('question_code') == 'CPOST_Q21_OTHER'
                      for a in (r.get('submission') or {}).get('answers') or []), r)

    _, second_speaker_token, _ = fx.create_participant(base, 'four_post_chatter_2')
    second_reg = fx.register(base, second_speaker_token, activity, 'speaker',
                             fx.field_answers(ctx['fields'], '后测倾诉者二'))
    fx.transition(base, admin_token, second_reg, 'approved')
    none_answers = _required_answers(cq, chatter_next=['nothing_for_now'])
    mixed_answers = [dict(a, value=['nothing_for_now', 'community_activities'])
                     if a['question_code'] == 'CPOST_Q21' else a for a in none_answers]
    s, r = call(base, 'POST', submit_route, {'answers': mixed_answers}, second_speaker_token)
    rep.check('FOUR-POST-28 正式提交也拒绝“暂时没有”混选',
              s == 400 and biz_code(r) == 'validation_failed', r)
    s, r = call(base, 'POST', submit_route, {'answers': none_answers + [
        {'question_code': 'CPOST_Q21_OTHER', 'value': '不应写入的隐藏值'}]}, second_speaker_token)
    submitted = r.get('submission') or {}
    rep.check('FOUR-POST-29 隐藏“其他”值不会写入正式答卷或导出底表',
              s == 200 and submitted.get('status') == 'submitted'
              and not any(a.get('question_code') == 'CPOST_Q21_OTHER'
                          for a in submitted.get('answers') or []), r)


def run(ctx):
    run_post_survey_checks(ctx)
