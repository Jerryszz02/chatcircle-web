#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""seed_demo.py — 本地开发库演示种子数据注入（由 seed_demo.sh 调用，也可单独使用）。

两种模式：
1) ``--sql-fixture --data-dir DIR``：对本地库直插「标准问卷模板 + 首版」。
   为什么用 SQL 直插：survey_templates.current_version_id ↔
   survey_template_versions.template_id 构成循环引用，无法经集合 API 一次创建
   （迁移 1785888660 顶部注释）；模板首版属平台级初始化数据（technical-design §5.7
   「迁移执行与模板初始化」），列名与该迁移建表结构一致，仅依赖标准库 sqlite3。
2) 默认模式（对运行中的实例经 API 注入）：机构、标准字段、演示管理员（走邀请码流程）、
   未使用邀请码、演示活动（已发布）、活动问卷（已开放）、演示参与者（报名已通过）。

全部按唯一键幂等（机构名 / field_code / template_code / 用户名 / activity_code），
可重复执行；已存在的条目打印「已存在，跳过」。
"""
import argparse
import json
import sqlite3
import sys
from datetime import datetime

# 标准库 HTTP 客户端（与 backend/tests/integration/cc_client.py 同形态，保持脚本自包含）
import urllib.error
import urllib.parse
import urllib.request

TEMPLATE_ID = 'tpltdemo0000001'
VERSION_ID = 'vertdemo0000001'
TEMPLATE_CODE = 'PARTICIPANT_POST_V1'
TEMPLATE_SCHEMA = {
    'questions': [
        {'question_code': 'MOOD', 'question_type': 'scale_1_5', 'title': '最近一周情绪状态',
         'required': True, 'locked': True, 'is_sensitive': True, 'order_index': 1},
        {'question_code': 'SAT', 'question_type': 'single_choice', 'title': '整体满意度',
         'required': True, 'order_index': 2,
         'options': [{'value': 'good', 'label': '满意'}, {'value': 'ok', 'label': '一般'}]},
        {'question_code': 'NOTE', 'question_type': 'text_long', 'title': '想说的话',
         'required': False, 'order_index': 3},
    ],
}

DEMO_ADMIN_PASS = 'demo_admin_123'
DEMO_USER_PASS = 'demo_user_123'


def call(base, method, path, body=None, token=None):
    req = urllib.request.Request(base + path, method=method)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=30) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b'{}')
        except Exception:
            return e.code, {}


def sql_fixture(data_dir):
    """直插模板与首版（幂等：按 template_code 去重）。"""
    db = '%s/data.db' % data_dir
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S.000Z')
    conn = sqlite3.connect(db, timeout=30)
    try:
        cur = conn.cursor()
        row = cur.execute(
            'SELECT id FROM survey_templates WHERE template_code = ?', (TEMPLATE_CODE,)).fetchone()
        if row:
            print('[INFO] 模板 %s 已存在，跳过 SQL 注入' % TEMPLATE_CODE)
            return
        cur.execute(
            "INSERT INTO survey_templates (id, template_code, name, description, status, "
            "current_version_id, created, updated) VALUES (?, ?, '活动后问卷 V1', '', 'active', ?, ?, ?)",
            (TEMPLATE_ID, TEMPLATE_CODE, VERSION_ID, now, now))
        cur.execute(
            "INSERT INTO survey_template_versions (id, template_id, version, schema_json, "
            "published_at, published_by, created, updated) VALUES (?, ?, 1, ?, ?, 'seeddemofix0001', ?, ?)",
            (VERSION_ID, TEMPLATE_ID, json.dumps(TEMPLATE_SCHEMA, ensure_ascii=False),
             '2026-08-01 00:00:00.000Z', now, now))
        conn.commit()
        print('[INFO] SQL 直插模板完成：%s / %s' % (TEMPLATE_ID, VERSION_ID))
    finally:
        conn.close()


def info(msg):
    print('[SEED] %s' % msg)


def main():
    ap = argparse.ArgumentParser(description='Chat Circles 本地演示种子数据')
    ap.add_argument('--sql-fixture', action='store_true', help='仅执行模板 SQL 直插后退出')
    ap.add_argument('--data-dir', default='', help='pb_data 目录（--sql-fixture 必填）')
    ap.add_argument('--base-url', default='http://127.0.0.1:8096', help='运行中的实例地址')
    ap.add_argument('--su', default='admin@cc.local', help='本地演示超管邮箱')
    ap.add_argument('--sp', default='cc_demo_pass_123', help='本地演示超管密码')
    args = ap.parse_args()

    if args.sql_fixture:
        if not args.data_dir:
            print('--sql-fixture 需要 --data-dir', file=sys.stderr)
            return 2
        sql_fixture(args.data_dir)
        return 0

    base = args.base_url
    s, auth = call(base, 'POST', '/api/collections/_superusers/auth-with-password',
                   {'identity': args.su, 'password': args.sp})
    if s != 200:
        print('[FAIL] 超管登录失败（%s）：%s' % (s, auth), file=sys.stderr)
        return 1
    st = auth['token']

    # ---------- 机构 ×2 ----------
    def ensure_org(name, require_approval, allow_sensitive):
        # URL 须为 ASCII：中文机构名经 quote 编码后放入 filter
        _, r = call(base, 'GET',
                    "/api/collections/organizations/records?filter=(name='%s')"
                    % urllib.parse.quote(name), token=st)
        items = r.get('items') or []
        if items:
            info('机构「%s」已存在，跳过' % name)
            return items[0]['id']
        s2, r2 = call(base, 'POST', '/api/collections/organizations/records',
                      {'name': name, 'status': 'active',
                       'require_activity_approval': require_approval,
                       'allow_sensitive_export': allow_sensitive, 'remark': '演示种子数据'}, st)
        assert s2 == 200, '创建机构失败：%s' % r2
        info('机构「%s」已创建' % name)
        return r2['id']

    org_a = ensure_org('演示机构·阿尔法', False, True)
    org_b = ensure_org('演示机构·贝塔', True, False)

    # ---------- 标准报名字段 ----------
    field_defs = [
        ('nickname', 'text', '昵称', True, False, None),
        ('phone', 'text', '手机号', False, True, None),
        ('age', 'number', '年龄', False, False, None),
        ('channel', 'multi_choice', '了解渠道', False, False,
         {'options': [{'value': 'friend', 'label': '朋友推荐'}, {'value': 'poster', 'label': '海报'}]}),
    ]
    _, r = call(base, 'GET', '/api/collections/registration_field_defs/records?perPage=100', token=st)
    existing = {x.get('field_code'): x['id'] for x in r.get('items', [])}
    fields = {}
    for code, ftype, label, reqd, sens, opts in field_defs:
        if code in existing:
            fields[code] = existing[code]
            continue
        s2, r2 = call(base, 'POST', '/api/collections/registration_field_defs/records',
                      {'organization_id': '', 'field_code': code, 'field_type': ftype,
                       'label': label, 'source_type': 'standard', 'is_sensitive': sens,
                       'options_json': opts, 'required_default': reqd, 'status': 'active'}, st)
        assert s2 == 200, '创建字段 %s 失败：%s' % (code, r2)
        fields[code] = r2['id']
        info('标准字段 %s 已创建' % code)

    # ---------- 模板版本（SQL 已注入）----------
    _, r = call(base, 'GET', '/api/collections/survey_templates/records?perPage=10', token=st)
    tpls = r.get('items') or []
    assert tpls, '模板不存在：请先执行 --sql-fixture（seed_demo.sh 会自动执行）'
    _, r = call(base, 'GET',
                "/api/collections/survey_template_versions/records?filter=template_id='%s'" % tpls[0]['id'],
                token=st)
    vers = r.get('items') or []
    assert vers, '模板版本不存在'
    ver_id = vers[0]['id']

    # ---------- 演示管理员（邀请码流程）+ 未使用邀请码 ----------
    def ensure_admin(org_id, username):
        _, r2 = call(base, 'GET',
                     "/api/collections/admin_accounts/records?filter=(username='%s')" % username,
                     token=st)
        if r2.get('items'):
            info('管理员 %s 已存在，跳过' % username)
            return
        s2, inv = call(base, 'POST', '/api/cc/super/invites', {'organization_id': org_id}, st)
        assert s2 == 200, '生成邀请码失败：%s' % inv
        s2, reg = call(base, 'POST', '/api/cc/auth/admin-register',
                       {'invite_code': inv['invite']['token'], 'username': username,
                        'password': DEMO_ADMIN_PASS})
        assert s2 == 200, '注册管理员失败：%s' % reg
        info('管理员 %s 已创建（密码 %s）' % (username, DEMO_ADMIN_PASS))

    ensure_admin(org_a, 'adminalpha')
    ensure_admin(org_b, 'adminbeta')

    fresh_invites = []
    for org_id, tag in ((org_a, '阿尔法'), (org_b, '贝塔')):
        _, r2 = call(base, 'GET',
                     f"/api/collections/admin_invites/records?filter=(organization_id='{org_id}'%26%26status='unused')",
                     token=st)
        if r2.get('items'):
            info('机构「%s」已有未使用邀请码（明文仅生成时可见），跳过' % tag)
            continue
        s2, inv = call(base, 'POST', '/api/cc/super/invites', {'organization_id': org_id}, st)
        assert s2 == 200, '生成邀请码失败：%s' % inv
        fresh_invites.append((tag, inv['invite']['token']))
        info('机构「%s」未使用邀请码已生成' % tag)

    # ---------- 演示管理员会话 ----------
    _, aauth = call(base, 'POST', '/api/collections/admin_accounts/auth-with-password',
                    {'identity': 'adminalpha', 'password': DEMO_ADMIN_PASS})
    AT = aauth['token']

    # ---------- 演示活动（已发布）----------
    _, r = call(base, 'GET',
                "/api/collections/activities/records?filter=(activity_code='CC_DEMO_AL_01')", token=st)
    acts = r.get('items') or []
    if acts:
        act_id = acts[0]['id']
        info('演示活动 CC_DEMO_AL_01 已存在，跳过')
    else:
        s2, act = call(base, 'POST', '/api/collections/activities/records', {
            'organization_id': org_a, 'activity_code': 'CC_DEMO_AL_01',
            'title': '演示·倾诉茶话会', 'description': '本地开发演示活动（种子脚本生成）',
            'location': '线上', 'start_time': '2026-08-10 12:00:00Z',
            'end_time': '2026-08-10 14:00:00Z', 'status': 'draft',
            'capacity_total': 20, 'capacity_speaker': 8, 'capacity_listener': 12,
            'registration_open': True,
            'registration_start_at': '2026-01-01 00:00:00Z',
            'registration_end_at': '2027-12-31 23:59:59Z',
            'checkin_qr_token': 'ckqr_demo_al_01', 'group_tag': '',
            'form_config_json': {'fields': [
                {'field_def_id': fields['nickname'], 'enabled': True, 'required': True},
                {'field_def_id': fields['phone'], 'enabled': True, 'required': False},
                {'field_def_id': fields['age'], 'enabled': True, 'required': False}]}}, AT)
        assert s2 == 200, '创建演示活动失败：%s' % act
        act_id = act['id']
        s2, pub = call(base, 'POST', '/api/cc/activities/%s/publish' % act_id, {}, AT)
        assert s2 == 200, '发布演示活动失败：%s' % pub
        info('演示活动 CC_DEMO_AL_01 已创建并发布')

    # ---------- 演示问卷（从模板复制并开放）----------
    _, r = call(base, 'GET',
                "/api/collections/activity_surveys/records?filter=(activity_id='%s')" % act_id, token=st)
    if r.get('items'):
        qr_token = r['items'][0].get('qr_token')
        info('演示问卷已存在，跳过')
    else:
        s2, sv = call(base, 'POST', '/api/cc/activities/%s/surveys' % act_id,
                      {'template_version_id': ver_id, 'title': '活动后问卷', 'role_scope': 'both'}, AT)
        assert s2 == 200, '创建演示问卷失败：%s' % sv
        qr_token = sv['survey']['qr_token']
        s2, o = call(base, 'POST', '/api/cc/activity-surveys/%s/open' % sv['survey']['id'], {}, AT)
        assert s2 == 200, '开放演示问卷失败：%s' % o
        info('演示问卷已创建并开放')

    # ---------- 演示参与者（报名已通过）----------
    for uname, role, nick in (('demo_speaker', 'speaker', '演示倾诉者'),
                              ('demo_listener', 'listener', '演示聆听者')):
        s2, p = call(base, 'POST', '/api/cc/auth/participant',
                     {'username': uname, 'password': DEMO_USER_PASS})
        assert s2 == 200, '参与者 %s 创建失败：%s' % (uname, p)
        pid, ptoken = p['record']['id'], p['token']
        s2, reg = call(base, 'POST', '/api/cc/activities/%s/register' % act_id,
                       {'activity_role': role,
                        'answers': [{'field_def_id': fields['nickname'], 'value': nick}]}, ptoken)
        assert s2 == 200, '报名失败：%s' % reg
        reg_id = reg['registration']['id']
        if reg['registration'].get('status') == 'pending':
            s2, tr = call(base, 'POST', '/api/cc/registrations/%s/transition' % reg_id,
                          {'to': 'approved'}, AT)
            assert s2 == 200, '审核失败：%s' % tr
        info('参与者 %s 就绪（密码 %s，报名已通过，角色 %s）' % (uname, DEMO_USER_PASS, role))

    # ---------- 汇总 ----------
    print()
    print('=' * 56)
    print('演示数据注入完成（本地开发库 %s 同源访问时端口以实际启动为准）' % base)
    print('  超级管理员：%s / %s' % (args.su, args.sp))
    print('  机构阿尔法管理员：adminalpha / %s（敏感导出开、发布审核关）' % DEMO_ADMIN_PASS)
    print('  机构贝塔管理员：adminbeta / %s（敏感导出关、发布审核开）' % DEMO_ADMIN_PASS)
    print('  参与者：demo_speaker / demo_listener，密码均为 %s' % DEMO_USER_PASS)
    print('  演示活动：CC_DEMO_AL_01（已发布）→ 参与者端 /a/<活动id>')
    print('  演示问卷：已开放 → 参与者端 /survey/%s' % qr_token)
    for tag, tok in fresh_invites:
        print('  机构「%s」未使用邀请码明文（仅本次显示）：%s' % (tag, tok))
    print('=' * 56)
    return 0


if __name__ == '__main__':
    sys.exit(main())
