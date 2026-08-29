# -*- coding: utf-8 -*-
"""fixture 工厂：平台级共享 fixture（标准报名字段、问卷模板）+ 各套件独立业务数据。

约定（test-plan §7）：
- 每个套件创建自己的机构/管理员/活动/参与者，活动代码与用户名带套件前缀，
  保证同一实例内各套件互不干扰、可整仓重复运行；
- 标准字段（organization_id 为空）属平台级数据，由 run.py 引导时创建一次，全套件复用；
- 标准问卷模板因集合循环引用（templates.current_version_id ↔ versions.template_id）
  无法经 API 一次创建（迁移 1785888660 注释），首版由 run.py --sql-fixture 以
  sqlite3 直插，此处仅查询。
"""
from datetime import datetime, timedelta, timezone

from cc_client import call

# 套件内统一使用的演示密码（一次性临时实例，无真实凭据）
PASSWORD = 'cc_it_pass_123'
_SUPER_TOKEN = ''


def configure_super_token(token):
    """配置仅供临时集成测试夹具使用的超管 token。"""
    global _SUPER_TOKEN
    _SUPER_TOKEN = token


def pb_dt(dt):
    """PocketBase 日期字符串（'YYYY-MM-DD HH:mm:ssZ'）。"""
    return dt.strftime('%Y-%m-%d %H:%M:%SZ')


def super_login(base, identity, password):
    s, auth = call(base, 'POST', '/api/collections/_superusers/auth-with-password',
                   {'identity': identity, 'password': password})
    assert s == 200 and auth.get('token'), '超管登录失败：%s' % auth
    return auth['token'], auth['record']['id']


def ensure_standard_fields(base, st):
    """平台标准报名字段（已存在则复用）。phone 为敏感字段，供导出过滤断言。返回 {field_code: id}。"""
    defs = [
        # (field_code, type, label, required_default, is_sensitive, options_json)
        ('nickname', 'text', '昵称', True, False, None),
        ('phone', 'text', '手机号', False, True, None),
        ('age', 'number', '年龄', False, False, None),
        ('channel', 'multi_choice', '了解渠道', False, False,
         {'options': [{'value': 'friend', 'label': '朋友推荐'}, {'value': 'poster', 'label': '海报'}]}),
    ]
    _, res = call(base, 'GET', '/api/collections/registration_field_defs/records?perPage=100', token=st)
    existing = {r.get('field_code'): r['id'] for r in res.get('items', [])}
    out = {}
    for code, ftype, label, reqd, sens, opts in defs:
        if code in existing:
            out[code] = existing[code]
            continue
        s, r = call(base, 'POST', '/api/collections/registration_field_defs/records',
                    {'organization_id': '', 'field_code': code, 'field_type': ftype, 'label': label,
                     'source_type': 'standard', 'is_sensitive': sens, 'options_json': opts,
                     'required_default': reqd, 'status': 'active'}, st)
        assert s == 200, '创建标准字段 %s 失败：%s' % (code, r)
        out[code] = r['id']
    return out


def template_version_id(base, st):
    """查询 SQL 预注入模板的首个版本。返回 (template_id, version_id)。"""
    _, tpls = call(base, 'GET', '/api/collections/survey_templates/records?perPage=10', token=st)
    items = tpls.get('items') or []
    assert items, '模板不存在：run.py --sql-fixture 未在 serve 前执行？'
    tpl = items[0]
    _, vers = call(base, 'GET',
                   "/api/collections/survey_template_versions/records?filter=template_id='%s'" % tpl['id'],
                   token=st)
    vitems = vers.get('items') or []
    assert vitems, '模板版本不存在'
    return tpl['id'], vitems[0]['id']


def create_org(base, st, name, require_approval=False, allow_sensitive=False):
    s, r = call(base, 'POST', '/api/collections/organizations/records',
                {'name': name, 'status': 'active', 'require_activity_approval': require_approval,
                 'allow_sensitive_export': allow_sensitive, 'remark': ''}, st)
    assert s == 200, '创建机构失败：%s' % r
    return r['id']


def create_admin(base, st, org_id, username, password=PASSWORD):
    """走邀请码流程创建管理员并登录，返回 (admin_id, token)。

    email 必填为 2026-08 改版新增（AC-24）：固定用 <username>@it.cc.local（用户名全局唯一，
    邮箱随之唯一）。
    """
    s, inv = call(base, 'POST', '/api/cc/super/invites', {'organization_id': org_id}, st)
    assert s == 200, '生成邀请码失败：%s' % inv
    token_plain = inv['invite']['token']
    s, reg = call(base, 'POST', '/api/cc/auth/admin-register',
                  {'invite_code': token_plain, 'username': username,
                   'email': '%s@it.cc.local' % username, 'password': password})
    assert s == 200, '管理员注册失败：%s' % reg
    uname = reg['record']['username']
    s, auth = call(base, 'POST', '/api/collections/admin_accounts/auth-with-password',
                   {'identity': uname, 'password': password})
    assert s == 200 and auth.get('token'), '管理员登录失败：%s' % auth
    return reg['record']['id'], auth['token']


def create_admin_via_impersonate(base, st, org_id, username, password=PASSWORD):
    """超管直建管理员 + impersonate 取登录态，返回 (admin_id, token)。

    内置 auth-with-password 有 per-IP 限流（20 次/10 分钟，一轮全量余量为 0，
    见 backend/tests/README.md 与 suite_hardening 头注释）：新增套件需要管理员
    token 时一律用本函数，不得再走邀请码 + auth-with-password 登录。
    """
    s, r = call(base, 'POST', '/api/collections/admin_accounts/records',
                {'username': username, 'password': password, 'passwordConfirm': password,
                 'organization_id': org_id, 'status': 'active'}, st)
    assert s == 200, '超管直建管理员失败：%s' % r
    admin_id = r['id']
    s, imp = call(base, 'POST', '/api/collections/admin_accounts/impersonate/%s' % admin_id, {}, st)
    assert s == 200 and imp.get('token'), 'impersonate 取管理员登录态失败：%s' % imp
    return admin_id, imp['token']


def create_participant(base, username, password=PASSWORD):
    """超管预置存量参与者并 impersonate，返回 (participant_id, token, created)。

    T1 后公开用户名端点只允许已有账号登录，不能再作为测试建号捷径；测试数据
    通过一次性临时实例的超管权限创建，避免生产接口重新出现绕过手机号验证的路径。
    """
    assert _SUPER_TOKEN, '未配置集成测试超管 token'
    normalized = username.strip().lower()
    s, record = call(base, 'POST', '/api/collections/participant_accounts/records', {
        'username': normalized,
        'password': password,
        'passwordConfirm': password,
        'status': 'active',
        'phone_migration_status': 'legacy_unbound',
    }, _SUPER_TOKEN)
    assert s == 200, '超管预置参与者失败：%s' % record
    participant_id = record['id']
    s, auth = call(base, 'POST',
                   '/api/collections/participant_accounts/impersonate/%s' % participant_id,
                   {}, _SUPER_TOKEN)
    assert s == 200 and auth.get('token'), 'impersonate 取参与者登录态失败：%s' % auth
    return participant_id, auth['token'], True


def create_activity(base, at, org_id, code, title, fields=None, caps=(10, 5, 5),
                    publish=True, start=None, end=None, reg_start=None, reg_end=None):
    """创建活动（数组版 form_config）并可选直接发布（机构须关闭发布审核），返回活动 id。

    fields: [(field_def_id, enabled, required)]；caps: (total, speaker, listener)。
    活动时间与报名窗口缺省为未来（30 天后举行、窗口开放中）：已结束活动不再接受报名
    （end_time 计入报名开放判定），缺省未来日期保证报名链路可用；显式传过去的
    start/end 可构造「已结束未手动关闭」场次（往期划分回归）。
    """
    now = datetime.now(timezone.utc)
    start = start or pb_dt(now + timedelta(days=30))
    end = end or pb_dt(now + timedelta(days=30, hours=2))
    reg_start = reg_start or pb_dt(now - timedelta(days=1))
    reg_end = reg_end or pb_dt(now + timedelta(days=30))
    field_cfg = [{'field_def_id': fid, 'enabled': en, 'required': req}
                 for fid, en, req in (fields or [])]
    s, act = call(base, 'POST', '/api/collections/activities/records', {
        'organization_id': org_id, 'activity_code': code, 'title': title,
        'description': '集成测试活动', 'location': '线上',
        'start_time': start, 'end_time': end,
        'status': 'draft', 'capacity_total': caps[0], 'capacity_speaker': caps[1],
        'capacity_listener': caps[2], 'registration_open': True,
        'registration_start_at': reg_start, 'registration_end_at': reg_end,
        'group_tag': '',
        'form_config_json': {'fields': field_cfg}}, at)
    assert s == 200, '创建活动失败：%s' % act
    aid = act['id']
    if publish:
        s, pub = call(base, 'POST', '/api/cc/activities/%s/publish' % aid, {}, at)
        assert s == 200, '发布活动失败：%s' % pub
    return aid


def checkin_token(base, at, act_id):
    """读取活动的服务端生成签到二维码 token（checkin_qr_token，FR-CHK-001）。

    安全加固后 token 由 activities.pb.js onRecordCreate 模型钩子生成（客户端不可指定、
    不可变更），管理员经原生 view 读本机构活动记录获取（匿名/参与者原生 view 已关闭）。
    """
    s, r = call(base, 'GET', '/api/collections/activities/records/%s' % act_id, token=at)
    assert s == 200 and r.get('checkin_qr_token'), '读取活动签到 token 失败：%s' % r
    return r['checkin_qr_token']


def self_checkin(base, qr_token, pt):
    """参与者自助签到（POST /api/cc/checkin/self {token}），返回 (status, body)，不断言。"""
    return call(base, 'POST', '/api/cc/checkin/self', {'token': qr_token}, pt)


def register(base, pt, act_id, role, answers):
    """提交报名并断言成功，返回 registration id。"""
    s, r = call(base, 'POST', '/api/cc/activities/%s/register' % act_id,
                {'activity_role': role, 'answers': answers}, pt)
    assert s == 200, '报名失败：%s' % r
    return r['registration']['id']


def transition(base, at, reg_id, to, reason=None, role=None):
    """调用报名状态迁移端点，返回 (status, body)；不断言结果，供正反两用。"""
    body = {'to': to}
    if reason is not None:
        body['reason'] = reason
    if role is not None:
        body['activity_role'] = role
    return call(base, 'POST', '/api/cc/registrations/%s/transition' % reg_id, body, at)


def field_answers(field_ids, nickname='测试昵称', phone=None, age=None):
    """按标准字段组装报名答案；nickname 为必填项。"""
    ans = [{'field_def_id': field_ids['nickname'], 'value': nickname}]
    if phone is not None:
        ans.append({'field_def_id': field_ids['phone'], 'value': phone})
    if age is not None:
        ans.append({'field_def_id': field_ids['age'], 'value': age})
    return ans


def nick_field_cfg(field_ids):
    """活动 form_config：nickname 启用且必填。"""
    return [(field_ids['nickname'], True, True)]


def create_survey(base, at, act_id, ver_id, title, role_scope='both'):
    """从模板创建活动问卷（draft），返回 (survey_id, qr_token)。"""
    s, sv = call(base, 'POST', '/api/cc/activities/%s/surveys' % act_id,
                 {'template_version_id': ver_id, 'title': title, 'role_scope': role_scope}, at)
    assert s == 200, '创建问卷失败：%s' % sv
    return sv['survey']['id'], sv['survey']['qr_token']


def create_training(base, at, org_id, code, title, status='draft'):
    """直连集合 API 创建培训（guards 强制非超管 status=draft），返回 (status, body)，不断言。"""
    return call(base, 'POST', '/api/collections/trainings/records', {
        'organization_id': org_id, 'title': title, 'training_code': code,
        'description': '集成测试培训', 'location': '线上',
        'start_time': '2026-08-15 12:00:00Z', 'end_time': '2026-08-15 14:00:00Z',
        'status': status}, at)


def training_token(base, at, training_id):
    """读取培训的服务端生成签到二维码 token（同 checkin_token 口径：管理员原生 view 读本机构记录）。"""
    s, r = call(base, 'GET', '/api/collections/trainings/records/%s' % training_id, token=at)
    assert s == 200 and r.get('checkin_qr_token'), '读取培训签到 token 失败：%s' % r
    return r['checkin_qr_token']


def self_training_checkin(base, qr_token, pt):
    """参与者培训自助签到（POST /api/cc/training-checkin/self {token}），返回 (status, body)，不断言。"""
    return call(base, 'POST', '/api/cc/training-checkin/self', {'token': qr_token}, pt)
