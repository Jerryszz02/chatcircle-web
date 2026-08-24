# -*- coding: utf-8 -*-
"""suite_reports — reports 报告集合（agent 产出物入库，迁移 21）。

断言：
- 超管可创建带文件报告（multipart）、list/view、字段回读（title/activity_id/status=draft/
  export_job_id/file 名）；
- file 为 protected：裸文件 URL 无 token 访问被拒（同 exports 的防护口径）；
- 机构管理员 / 参与者 / 匿名的 create 与 list/view 均被拒（rules 全 null，仅超管）。
"""
import json
import urllib.error
import urllib.request

import cc_fixture as fx
from cc_client import call

REPORT_MD = '# 报告校验场 数据报告\n\n本期服务 10 人次。\n'.encode('utf-8')

# 与 cc_client 同因：urllib 在 macOS 拾取系统代理，本机代理转发 127.0.0.1 会 502 空响应，
# 故 multipart 调用同样走禁用代理的 opener（仅打本机回环实例）
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _multipart_call(base, method, path, fields=None, file_field=None, file_name=None,
                    file_bytes=None, file_mime='application/octet-stream', token=None):
    """stdlib 手拼 multipart/form-data（cc_client.call 只支持 JSON）。返回 (status, json)。"""
    boundary = '----ccitboundary7MA4YWxkTrZu0gW'
    body = bytearray()

    def w(s):
        body.extend(s.encode('utf-8'))

    for k, v in (fields or {}).items():
        w('--%s\r\n' % boundary)
        w('Content-Disposition: form-data; name="%s"\r\n\r\n' % k)
        w('%s\r\n' % v)
    if file_field:
        w('--%s\r\n' % boundary)
        w('Content-Disposition: form-data; name="%s"; filename="%s"\r\n' % (file_field, file_name))
        w('Content-Type: %s\r\n\r\n' % file_mime)
        body.extend(file_bytes)
        w('\r\n')
    w('--%s--\r\n' % boundary)

    req = urllib.request.Request(base + path, method=method, data=bytes(body))
    req.add_header('Content-Type', 'multipart/form-data; boundary=%s' % boundary)
    if token:
        req.add_header('Authorization', token)
    try:
        with _OPENER.open(req, timeout=30) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload or b'{}')
        except Exception:
            return e.code, {'_raw': payload.decode('utf-8', 'replace')}


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    rep.section('suite_reports：reports 报告集合（agent 产出物）')

    org = fx.create_org(base, st, '报告机构')
    # ⚠️ 不用 fx.create_admin（其内置 auth-with-password 登录会消耗 authguard per-IP 预算，
    # 见 suite_hardening 文件头）；改为超管直建 + impersonate 换取管理员令牌（同语义身份）
    s, adm = call(base, 'POST', '/api/collections/admin_accounts/records',
                  {'username': 'rep_admin', 'password': 'cc_it_pass_123',
                   'passwordConfirm': 'cc_it_pass_123', 'organization_id': org,
                   'status': 'active'}, st)
    assert s == 200, '直建管理员失败：%s' % adm
    s, imp = call(base, 'POST', '/api/collections/admin_accounts/impersonate/%s' % adm['id'],
                  {}, st)
    assert s == 200 and imp.get('token'), 'impersonate 管理员失败：%s' % imp
    at = imp['token']
    act = fx.create_activity(base, at, org, 'CC_IT_REP_01', '报告校验场',
                             fields=fx.nick_field_cfg(ctx['fields']))
    _, pt, _ = fx.create_participant(base, 'repuser01')

    # ---------- 1. 超管创建（multipart，含文件）与字段回读 ----------
    s, r = _multipart_call(base, 'POST', '/api/collections/reports/records',
                           fields={'title': '活动数据报告 v1', 'activity_id': act,
                                   'status': 'draft', 'export_job_id': 'jobfake12345678'},
                           file_field='file', file_name='report.md',
                           file_bytes=REPORT_MD, file_mime='text/markdown', token=st)
    rec = r.get('id')
    rep.check('REP-01 超管创建带文件报告成功', s == 200 and bool(rec), r)
    if not rec:
        return
    rep.check('REP-02 字段回读正确（title/activity_id/status=draft/export_job_id/file 名）',
              r.get('title') == '活动数据报告 v1' and r.get('activity_id') == act
              and r.get('status') == 'draft' and r.get('export_job_id') == 'jobfake12345678'
              and bool(r.get('file')), r)

    # ---------- 2. 超管 list/view ----------
    s, r = call(base, 'GET', '/api/collections/reports/records?perPage=10', token=st)
    rep.check('REP-03 超管 list reports 可见（≥1）', s == 200 and r.get('totalItems', 0) >= 1, r)
    s, r = call(base, 'GET', '/api/collections/reports/records/%s' % rec, token=st)
    rep.check('REP-04 超管 view reports 可见', s == 200 and r.get('id') == rec, r)
    fname = r.get('file')

    # ---------- 3. protected 文件：裸 URL（无 token）访问被拒 ----------
    s, _ = call(base, 'GET', '/api/files/reports/%s/%s' % (rec, fname), raw=True)
    rep.check('REP-05 报告文件 protected：无 token 访问被拒（403/404）',
              s in (403, 404), 'status=%s' % s)

    # ---------- 4. 非超管写/读被拒 ----------
    labels = (('机构管理员', at), ('参与者', pt), ('匿名', None))
    for i, (label, tok) in enumerate(labels):
        s, r = _multipart_call(base, 'POST', '/api/collections/reports/records',
                               fields={'title': '越权报告', 'status': 'draft'},
                               file_field='file', file_name='x.md', file_bytes=b'x',
                               token=tok)
        rep.check('REP-%02d %s create reports 被拒（403/404）' % (6 + i * 3, label),
                  s in (403, 404), 'status=%s' % s)
        s, r = call(base, 'GET', '/api/collections/reports/records?perPage=10', token=tok)
        blocked = s in (403, 404) or (s == 200 and r.get('totalItems', 0) == 0)
        rep.check('REP-%02d %s list reports 被拒或为空集' % (7 + i * 3, label),
                  blocked, 'status=%s body=%s' % (s, r))
        s, r = call(base, 'GET', '/api/collections/reports/records/%s' % rec, token=tok)
        rep.check('REP-%02d %s view reports 被拒（403/404）' % (8 + i * 3, label),
                  s in (403, 404), 'status=%s' % s)

    # ---------- 5. 创建审计（report.upload）由服务端钩子同事务写入 ----------
    s, r = call(base, 'GET',
                f"/api/collections/audit_logs/records?filter=(action='report.upload'%26%26target_id='{rec}')",
                token=st)
    items = r.get('items') or []
    rep.check('REP-15 创建报告自动写审计（report.upload，actor=创建者，机构经活动反查）',
              s == 200 and len(items) == 1
              and items[0].get('actor_id') == ctx['sid']
              and items[0].get('actor_role') == 'super_admin'
              and items[0].get('organization_id') == org, r)
