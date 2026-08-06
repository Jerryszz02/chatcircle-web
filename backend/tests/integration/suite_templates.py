# -*- coding: utf-8 -*-
"""suite_templates — 超管问卷模板管理端点（FR-SUR-001/011、PRD §11.3 模板发布审计）。

断言：POST /api/cc/super/templates 新建模板 + 首版（事务回补 current_version_id）
与 POST /api/cc/super/templates/{id}/publish 发布新版本（version 递增、
current_version_id 移动）的访问控制、schema 校验与规范化（options → options_json、
order_index 按数组顺序重排）、停用模板拒发、template.create/template.publish 审计。
"""
import json
import urllib.parse

import cc_fixture as fx
from cc_client import biz_code, call

VALID_SCHEMA = {
    'questions': [
        {'question_code': 'MOOD', 'question_type': 'scale_1_5', 'title': '最近一周情绪状态',
         'required': True, 'locked': True, 'is_sensitive': True},
        {'question_code': 'SAT', 'question_type': 'single_choice', 'title': '整体满意度',
         'required': True,
         'options': [{'value': 'good', 'label': '满意'}, {'value': 'ok', 'label': '一般'}]},
        {'question_code': 'NOTE', 'question_type': 'text_long', 'title': '想说的话',
         'required': False},
    ],
}


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    rep.section('suite_templates：模板新建与版本发布（FR-SUR-001/011、PRD §11.3）')

    _, AT = fx.create_admin(base, st, fx.create_org(base, st, '模板机构'), 'tpl_admin')
    _, PT, _ = fx.create_participant(base, 'tpl_user')

    # ---------- 1. 访问控制 ----------
    s, r = call(base, 'POST', '/api/cc/super/templates', {'template_code': 'TPL_X1'}, AT)
    rep.check('TPL-01 机构管理员新建模板 → 403', s in (401, 403), r)
    s, r = call(base, 'POST', '/api/cc/super/templates', {'template_code': 'TPL_X1'}, PT)
    rep.check('TPL-02 参与者新建模板 → 403', s in (401, 403), r)
    s, r = call(base, 'POST', '/api/cc/super/templates', {'template_code': 'TPL_X1'})
    rep.check('TPL-03 未认证新建模板 → 401', s == 401, r)
    s, r = call(base, 'POST', '/api/cc/super/templates/%s/publish' % ctx['tpl_id'],
                {'schema_json': VALID_SCHEMA}, AT)
    rep.check('TPL-04 机构管理员发布版本 → 403', s in (401, 403), r)

    # ---------- 2. 校验失败分支 ----------
    s, r = call(base, 'POST', '/api/cc/super/templates',
                {'template_code': 'bad-code', 'name': 'x', 'schema_json': VALID_SCHEMA}, st)
    rep.check('TPL-05 template_code 格式非法 → 400', s == 400 and biz_code(r) == 'validation_failed', r)
    s, r = call(base, 'POST', '/api/cc/super/templates',
                {'template_code': 'TPL_BAD_EMPTY', 'name': 'x',
                 'schema_json': {'questions': []}}, st)
    rep.check('TPL-06 questions 空数组 → 400', s == 400 and biz_code(r) == 'validation_failed', r)
    s, r = call(base, 'POST', '/api/cc/super/templates',
                {'template_code': 'TPL_BAD_NOOPT', 'name': 'x',
                 'schema_json': {'questions': [
                     {'question_code': 'Q1', 'question_type': 'single_choice', 'title': '无选项'}]}}, st)
    rep.check('TPL-07 选择题无选项 → 400', s == 400 and biz_code(r) == 'validation_failed', r)
    s, r = call(base, 'POST', '/api/cc/super/templates',
                {'template_code': 'TPL_BAD_DUP', 'name': 'x',
                 'schema_json': {'questions': [
                     {'question_code': 'Q1', 'question_type': 'text_short', 'title': '甲'},
                     {'question_code': 'Q1', 'question_type': 'text_short', 'title': '乙'}]}}, st)
    rep.check('TPL-08 question_code 重复 → 400', s == 400 and biz_code(r) == 'validation_failed', r)
    s, r = call(base, 'POST', '/api/cc/super/templates',
                {'template_code': 'TPL_BAD_TYPE', 'name': 'x',
                 'schema_json': {'questions': [
                     {'question_code': 'Q1', 'question_type': 'dropdown', 'title': '非法题型'}]}}, st)
    rep.check('TPL-09 非法题型 → 400', s == 400 and biz_code(r) == 'validation_failed', r)

    # ---------- 3. 新建模板成功（含规范化断言） ----------
    s, r = call(base, 'POST', '/api/cc/super/templates',
                {'template_code': 'TPL_IT_MAIN', 'name': '集成测试模板',
                 'description': 'suite_templates', 'schema_json': VALID_SCHEMA}, st)
    tpl = r.get('template') or {}
    ver = r.get('version') or {}
    rep.check('TPL-10 新建模板成功（version=1，题目数=3）',
              s == 200 and ver.get('version') == 1 and ver.get('question_count') == 3
              and tpl.get('current_version_id') == ver.get('id'), r)
    tpl_id = tpl.get('id') or ''

    s, r = call(base, 'GET', '/api/collections/survey_template_versions/records/%s' % ver.get('id'), token=st)
    schema = r.get('schema_json') or {}
    if isinstance(schema, str):
        schema = json.loads(schema)
    questions = schema.get('questions') or []
    sat = next((q for q in questions if q.get('question_code') == 'SAT'), {})
    rep.check('TPL-11 落库 schema 规范化：options → options_json、order_index 按序重排',
              s == 200 and len(questions) == 3
              and questions[0].get('order_index') == 0 and questions[2].get('order_index') == 2
              and isinstance(sat.get('options_json'), dict)
              and len((sat.get('options_json') or {}).get('options') or []) == 2
              and 'options' not in sat, r)

    s, r = call(base, 'POST', '/api/cc/super/templates',
                {'template_code': 'TPL_IT_MAIN', 'name': '重复', 'schema_json': VALID_SCHEMA}, st)
    rep.check('TPL-12 template_code 重复 → 400', s == 400 and biz_code(r) == 'validation_failed', r)

    # ---------- 4. 发布新版本 ----------
    v2_schema = json.loads(json.dumps(VALID_SCHEMA))
    v2_schema['questions'].append(
        {'question_code': 'EXTRA', 'question_type': 'text_short', 'title': '补充说明'})
    s, r = call(base, 'POST', '/api/cc/super/templates/%s/publish' % tpl_id,
                {'schema_json': v2_schema}, st)
    ver2 = r.get('version') or {}
    rep.check('TPL-13 发布新版本成功（version=2，题目数=4）',
              s == 200 and ver2.get('version') == 2 and ver2.get('question_count') == 4, r)
    s, r = call(base, 'GET', '/api/collections/survey_templates/records/%s' % tpl_id, token=st)
    rep.check('TPL-14 current_version_id 已移动到新版本',
              s == 200 and r.get('current_version_id') == ver2.get('id'), r)
    s, r = call(base, 'GET', '/api/collections/survey_template_versions/records/%s' % ver.get('id'), token=st)
    schema1 = r.get('schema_json') or {}
    if isinstance(schema1, str):
        schema1 = json.loads(schema1)
    rep.check('TPL-15 已发布首版不可变（仍为 3 题，FR-SUR-011）',
              s == 200 and len(schema1.get('questions') or []) == 3, r)

    s, r = call(base, 'POST', '/api/cc/super/templates/%s/publish' % tpl_id,
                {'schema_json': {'questions': []}}, st)
    rep.check('TPL-16 发布非法 schema → 400', s == 400 and biz_code(r) == 'validation_failed', r)
    s, r = call(base, 'POST', '/api/cc/super/templates/notexist0000000/publish',
                {'schema_json': VALID_SCHEMA}, st)
    rep.check('TPL-17 模板不存在 → 404', s == 404 and biz_code(r) == 'not_found', r)

    # 停用模板拒发
    s, r = call(base, 'PATCH', '/api/collections/survey_templates/records/%s' % tpl_id,
                {'status': 'disabled'}, st)
    rep.check('TPL-18 超管停用模板（前置）', s == 200, r)
    s, r = call(base, 'POST', '/api/cc/super/templates/%s/publish' % tpl_id,
                {'schema_json': VALID_SCHEMA}, st)
    rep.check('TPL-19 停用模板发布 → 400 invalid_transition',
              s == 400 and biz_code(r) == 'invalid_transition', r)

    # ---------- 5. 审计 ----------
    action_filter = urllib.parse.quote(
        "(action='template.create' || action='template.publish') && target_id='%s'" % tpl_id)
    s, r = call(base, 'GET',
                '/api/collections/audit_logs/records?filter=%s&perPage=10' % action_filter, token=st)
    actions = sorted(item.get('action') for item in (r.get('items') or []))
    rep.check('TPL-20 写审计 template.create / template.publish（PRD §11.3）',
              s == 200 and actions == ['template.create', 'template.publish'], r)
