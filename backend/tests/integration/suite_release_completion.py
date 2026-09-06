"""上线整改：不可关闭的姓名、计划配置、关闭配对、邮件回跳。无真实邮件或短信。"""
from datetime import datetime, timedelta, timezone
from urllib.parse import quote
import cc_fixture as fx
from cc_client import call, biz_code


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    rep.section('suite_release_completion：上线整改')
    org = fx.create_org(base, st, '上线整改测试机构')
    _, at = fx.create_admin_via_impersonate(base, st, org, 'release_admin')
    name_id = ctx['fields']['FULL_NAME']
    act = fx.create_activity(base, at, org, 'CC_IT_RELEASE', '上线整改', fields=[
        (ctx['fields']['nickname'], False, False), (name_id, False, False)])
    path = '/api/collections/activities/records/' + act
    s, record = call(base, 'GET', path, token=at)
    rep.check('REL-01 新活动默认启用配对', s == 200 and record.get('pairing_enabled') is True, record)
    s, public = call(base, 'GET', '/api/cc/public/activities/' + act)
    name = next((f for f in public.get('registration_fields', []) if f['id'] == name_id), {})
    rep.check('REL-02 显式关闭姓名仍公开必填敏感字段', name.get('required') is True and name.get('is_sensitive') is True, name)
    _, pt, _ = fx.create_participant(base, 'release_user')
    for title, answers in [('缺少姓名', []), ('空白姓名', [{'field_def_id': name_id, 'value': '  \t '}])]:
        s, body = call(base, 'POST', '/api/cc/activities/%s/register' % act,
                       {'activity_role': 'speaker', 'answers': answers}, pt)
        rep.check('REL-03 ' + title + '拒绝报名', s == 400 and biz_code(body) == 'REQUIRED_FIELD_MISSING', body)
    s, cfg = call(base, 'PATCH', path, {'form_config_json': {'fields': [
        {'field_def_id': name_id, 'enabled': False, 'required': False},
        {'field_def_id': ctx['fields']['nickname'], 'enabled': False, 'required': False}]}}, at)
    name_cfg = next((f for f in cfg.get('form_config_json', {}).get('fields', []) if f['field_def_id'] == name_id), {})
    rep.check('REL-04 更新配置也强制启用且必填姓名', s == 200 and name_cfg.get('required') and name_cfg.get('enabled'), cfg)
    s, field = call(base, 'PATCH', '/api/collections/registration_field_defs/records/' + name_id,
                    {'required_default': False, 'status': 'disabled', 'is_sensitive': False, 'role_scope': 'speaker'}, st)
    rep.check('REL-05 标准姓名定义不能降级或停用', s == 200 and field.get('status') == 'active' and field.get('is_sensitive') and field.get('role_scope') == 'both', field)
    rid = fx.register(base, pt, act, 'speaker', [{'field_def_id': name_id, 'value': '测试姓名甲'}])
    rep.check('REL-06 姓名填写后报名成功', bool(rid))
    now = datetime.now(timezone.utc)
    planned = fx.pb_dt(now + timedelta(days=29))
    s, record = call(base, 'PATCH', path, {'pairing_enabled': False, 'planned_checkin_at': planned}, at)
    rep.check('REL-07 现场配置持久化', s == 200 and record.get('pairing_enabled') is False and bool(record.get('planned_checkin_at')), record)
    s, body = call(base, 'POST', '/api/cc/activities/%s/pairings/start' % act, {}, at)
    rep.check('REL-08 关闭配对后服务端拒绝启动', s == 400 and biz_code(body) == 'pairing_disabled', body)
    s, body = call(base, 'GET', '/api/cc/activities/%s/my-pairing' % act, token=pt)
    rep.check('REL-09 本人快照明确配对已关闭', s == 200 and body.get('pairing_enabled') is False, body)
    s, body = call(base, 'PATCH', path, {'planned_checkin_at': fx.pb_dt(now + timedelta(days=31))}, at)
    rep.check('REL-10 拒绝晚于活动结束的签到计划', s == 400, body)
    survey_payload = {'template_version_id': ctx['ver_id'], 'title': '活动后反馈', 'role_scope': 'both', 'phase': 'after', 'planned_open_at': fx.pb_dt(now + timedelta(days=31))}
    s, body = call(base, 'POST', '/api/cc/activities/%s/surveys' % act, survey_payload, at)
    survey = body.get('survey', {})
    rep.check('REL-11 问卷阶段及预计时间保存且不自动开放', s == 200 and survey.get('phase') == 'after' and survey.get('planned_open_at') and survey.get('status') == 'draft', body)
    for patch in [{'phase': 'invalid'}, {'planned_open_at': 'not-a-date'}]:
        s, body = call(base, 'POST', '/api/cc/activities/%s/surveys' % act, {**survey_payload, **patch}, at)
        rep.check('REL-12 拒绝非法问卷计划', s == 400, body)
    s, body = call(base, 'POST', '/api/cc/activities/%s/duplicate' % act, {}, at)
    copy = body.get('activity', {})
    rep.check('REL-13 复制保留配对开关但重置签到计划', s == 200 and copy.get('pairing_enabled') is False and not copy.get('planned_checkin_at'), body)
    s, body = call(base, 'GET', '/api/collections/activity_surveys/records?filter=' + quote('activity_id="%s"' % copy.get('id')), token=at)
    copies = body.get('items', [])
    rep.check('REL-14 复制问卷保留阶段但清空过期计划', len(copies) == 1 and copies[0].get('phase') == 'after' and not copies[0].get('planned_open_at'), body)
    s, admin_collection = call(base, 'GET', '/api/collections/admin_accounts', token=st)
    rep.check('REL-15 邮件验证和重置链接回到网站', s == 200 and '/admin/verify-email#token={TOKEN}' in admin_collection.get('verificationTemplate', {}).get('body', '') and '/admin/reset-password#token={TOKEN}' in admin_collection.get('resetPasswordTemplate', {}).get('body', ''), s)

    s, body = call(base, 'POST', '/api/cc/activities/%s/duplicate' % act, {'as_template': True}, at)
    template = body.get('activity', {})
    rep.check('REL-16 另存为机构模板保留草稿', s == 200 and template.get('is_template') is True and template.get('status') == 'draft', body)
    s, body = call(base, 'POST', '/api/cc/activities/%s/publish' % template.get('id'), {}, at)
    rep.check('REL-17 模板不能直接公开发布', s == 400, body)
    s, body = call(base, 'POST', '/api/cc/activities/%s/duplicate' % template.get('id'), {}, at)
    rep.check('REL-18 从模板创建的是独立普通活动', s == 200 and body.get('activity', {}).get('is_template') is False and body.get('activity', {}).get('id') != template.get('id'), body)

    for invalid_shape in [[], 7]:
        s, body = call(base, 'PATCH', path, {'form_config_json': invalid_shape}, at)
        form = body.get('form_config_json')
        rep.check('REL-19 非对象配置归一化后仍保存强制姓名', s == 200 and isinstance(form, dict) and any(item.get('field_def_id') == name_id and item.get('required') for item in form.get('fields', [])), body)
