# -*- coding: utf-8 -*-
"""已确认的 Chatter / Listener 报名表：公开字段与真实报名 API 回归。"""
import uuid

import cc_fixture as fx
from cc_client import biz_code, call


SPEAKER_REQUIRED = {
    'FULL_NAME', 'C24_EMAIL', 'C24_PHONE', 'C24_AGE', 'C24_TRANSITION',
    'C24_ROLE', 'C24_PRIVACY', 'C24_CHOICE', 'C24_CONSENT',
}
LISTENER_REQUIRED = {
    'FULL_NAME', 'L24_EMAIL', 'L24_AGE', 'L24_MOTIVATION',
    'L24_ROLE', 'L24_TRAINING', 'L24_PRIVACY', 'L24_CONSENT',
}


def _answers(fields, values):
    return [{'field_def_id': fields[code]['id'], 'value': value}
            for code, value in values.items()]


def _submit(base, activity_id, role, token, fields, values):
    return call(base, 'POST', '/api/cc/activities/%s/register' % activity_id,
                {'activity_role': role, 'answers': _answers(fields, values)}, token)


def _participant(base, prefix, suffix):
    return fx.create_participant(base, '%s_%s' % (prefix, suffix))[1]


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    rep.section('suite_registration_templates：双角色报名模板与旧活动兼容')
    suffix = uuid.uuid4().hex[:8]
    org = fx.create_org(base, st, '报名模板机构_%s' % suffix)
    _, admin = fx.create_admin_via_impersonate(base, st, org, 'rt_admin_%s' % suffix)
    defs_status, defs_body = call(base, 'GET', '/api/collections/registration_field_defs/records?perPage=200', token=st)
    # Other suites may create organization-scoped fields with the same code.
    # An unfiltered code->record map can silently replace the platform field ID.
    all_defs = {item['field_code']: item for item in defs_body.get('items') or []
                if not item.get('organization_id')}
    standard_ids = ctx['fields']
    test_only_codes = ('nickname', 'phone', 'age', 'channel')
    rep.check('RT-00 测试夹具旧字段齐备',
              defs_status == 200 and all(code in all_defs and
                                         standard_ids.get(code) == all_defs[code]['id']
                                         for code in test_only_codes),
              {'status': defs_status, 'codes': sorted(all_defs)})
    if not all(code in all_defs and standard_ids.get(code) == all_defs[code]['id']
               for code in test_only_codes):
        return

    # 新活动先以空配置建立，正式新表字段按定义默认启用；随后仅关闭
    # run.py 在迁移后人为创建的四个旧测试字段，不改变平台字段定义。
    activity_id = fx.create_activity(base, admin, org, 'CC_IT_REGTPL_%s' % suffix,
                                     '双角色报名模板活动', fields=[], publish=False)
    test_only_off = [{'field_def_id': standard_ids[code], 'enabled': False, 'required': False}
                     for code in test_only_codes]
    s, updated = call(base, 'PATCH', '/api/collections/activities/records/%s' % activity_id,
                      {'form_config_json': {'fields': test_only_off}}, admin)
    rep.check('RT-00a 仅关闭本活动的旧测试字段', s == 200, updated if s != 200 else '')
    if s != 200:
        return
    s, published = call(base, 'POST', '/api/cc/activities/%s/publish' % activity_id, {}, admin)
    rep.check('RT-00b 新报名模板活动发布', s == 200, published if s != 200 else '')
    if s != 200:
        return
    s, detail = call(base, 'GET', '/api/cc/public/activities/%s' % activity_id)
    public_fields = detail.get('registration_fields') or []
    fields = {field['field_code']: field for field in public_fields}
    codes = set(fields)
    rep.check('RT-01 公开详情只下发启用字段，含两份新报名表',
              s == 200 and detail.get('registration', {}).get('open') is True
              and 'FULL_NAME' in codes and 'C24_EMAIL' in codes and 'L24_EMAIL' in codes
              and all(code == 'FULL_NAME' or code.startswith(('C24_', 'L24_')) for code in codes),
              {'status': s, 'codes': sorted(codes)})
    if not {'FULL_NAME', 'C24_EMAIL', 'L24_EMAIL'} <= codes:
        return

    orders = [(field.get('config_json') or {}).get('order_index', 0) for field in public_fields]
    speaker_required = {f['field_code'] for f in public_fields
                        if f.get('required') and f.get('role_scope') in ('both', 'speaker')
                        and not (f.get('config_json') or {}).get('show_when')}
    listener_required = {f['field_code'] for f in public_fields
                         if f.get('required') and f.get('role_scope') in ('both', 'listener')
                         and not (f.get('config_json') or {}).get('show_when')}
    metadata_codes = {'C24_SOURCE', 'C24_SOURCE_OTHER', 'L24_SOURCE', 'L24_SOURCE_OTHER'}
    rep.check('RT-02 公开字段有稳定顺序、角色和交互元数据',
              all(isinstance(order, int) for order in orders)
              and orders == sorted(orders)
              and speaker_required == SPEAKER_REQUIRED
              and listener_required == LISTENER_REQUIRED
              and metadata_codes <= codes
              and fields['C24_EMAIL']['config_json'].get('input_type') == 'email'
              and fields['L24_EMAIL']['config_json'].get('input_type') == 'email'
              and fields['C24_SOURCE_OTHER']['config_json'].get('show_when')
              == {'field_code': 'C24_SOURCE', 'value': 'other'}
              and fields['L24_SOURCE_OTHER']['config_json'].get('show_when')
              == {'field_code': 'L24_SOURCE', 'value': 'other'}
              and fields['C24_CONSENT']['config_json'].get('input_type') == 'ack'
              and fields['L24_CONSENT']['config_json'].get('input_type') == 'ack',
              {'orders': orders, 'speaker_required': sorted(speaker_required),
               'listener_required': sorted(listener_required)})
    if not (SPEAKER_REQUIRED | LISTENER_REQUIRED | metadata_codes) <= codes:
        return

    speaker = {
        'FULL_NAME': '测试 Chatter', 'C24_EMAIL': 'chatter@example.org',
        'C24_PHONE': '+65 6123 4567', 'C24_AGE': '25_35',
        'C24_TRANSITION': 'none_applies', 'C24_ROLE': 'agree',
        'C24_PRIVACY': 'agree', 'C24_CHOICE': 'agree', 'C24_CONSENT': 'agree',
    }
    listener = {
        'FULL_NAME': '测试 Listener', 'L24_EMAIL': 'listener@example.org',
        'L24_PHONE': '+65 6123 4568', 'L24_AGE': '21_29',
        'L24_MOTIVATION': '愿意练习专注倾听。', 'L24_ROLE': 'agree',
        'L24_TRAINING': 'agree', 'L24_PRIVACY': 'agree', 'L24_CONSENT': 'agree',
    }
    s, result = _submit(base, activity_id, 'speaker', _participant(base, 'regtpl_c', suffix),
                        fields, speaker)
    rep.check('RT-03 Chatter 全部必填项可完成报名',
              s == 200 and result.get('registration', {}).get('activity_role') == 'speaker'
              and result.get('registration', {}).get('status') == 'pending', result)
    listener_with_other = dict(listener, L24_SOURCE='other', L24_SOURCE_OTHER='社区伙伴')
    s, result = _submit(base, activity_id, 'listener', _participant(base, 'regtpl_l', suffix),
                        fields, listener_with_other)
    rep.check('RT-04 Listener 全部必填项和 Other 补充项可完成报名',
              s == 200 and result.get('registration', {}).get('activity_role') == 'listener'
              and result.get('registration', {}).get('status') == 'pending', result)

    cases = [
        ('RT-05 不适用角色字段拒绝', 'listener',
         dict(listener, C24_EMAIL='wrong@example.org'), 'field_not_applicable'),
        ('RT-06 选 Other 时缺少补充项拒绝', 'speaker',
         dict(speaker, C24_SOURCE='other'), 'REQUIRED_FIELD_MISSING'),
        ('RT-07 未选 Other 却提交补充项拒绝', 'listener',
         dict(listener, L24_SOURCE='social_platform', L24_SOURCE_OTHER='不应出现'),
         'field_not_applicable'),
        ('RT-08 非法邮箱拒绝', 'speaker',
         dict(speaker, C24_EMAIL='invalid-email'), 'INVALID_VALUE'),
        ('RT-09 未勾选必填确认拒绝', 'listener',
         {code: value for code, value in listener.items() if code != 'L24_CONSENT'},
         'REQUIRED_FIELD_MISSING'),
        ('RT-10 非法确认选项拒绝', 'speaker',
         dict(speaker, C24_CONSENT='decline'), 'INVALID_VALUE'),
    ]
    for index, (name, role, values, expected) in enumerate(cases):
        s, result = _submit(base, activity_id, role,
                            _participant(base, 'regtpl_bad%d' % index, suffix), fields, values)
        rep.check(name, s == 400 and biz_code(result) == expected, result)

    # 旧活动显式关闭全部新字段，并启用一个迁移前的标准字段。
    new_defs = [item for code, item in all_defs.items() if code.startswith(('C24_', 'L24_'))]
    rep.check('RT-11 平台字段定义可查询，用于构造旧活动配置',
              defs_status == 200 and len(new_defs) >= 20 and 'nickname' in all_defs,
              {'status': defs_status, 'new_count': len(new_defs)})
    if not new_defs or 'nickname' not in all_defs:
        return
    old_fields = [(item['id'], False, False) for item in new_defs]
    old_fields.extend((standard_ids[code], False, False)
                      for code in test_only_codes if code != 'nickname')
    old_fields.append((standard_ids['nickname'], True, True))
    old_id = fx.create_activity(base, admin, org, 'CC_IT_REGOLD_%s' % suffix,
                                '旧报名字段兼容活动', fields=old_fields)
    s, old_detail = call(base, 'GET', '/api/cc/public/activities/%s' % old_id)
    old_public = {field['field_code']: field for field in old_detail.get('registration_fields') or []}
    rep.check('RT-12 显式关闭的新字段不下发，旧字段可显式启用',
              s == 200 and set(old_public) == {'FULL_NAME', 'nickname'}
              and old_public['nickname'].get('required') is True,
              {'status': s, 'codes': sorted(old_public)})
    if not {'FULL_NAME', 'nickname'} <= set(old_public):
        return
    s, result = _submit(base, old_id, 'speaker', _participant(base, 'regtpl_old', suffix),
                        old_public, {'FULL_NAME': '历史用户', 'nickname': '旧昵称'})
    rep.check('RT-13 旧活动关闭新字段后仍可按旧配置报名',
              s == 200 and result.get('registration', {}).get('status') == 'pending', result)
