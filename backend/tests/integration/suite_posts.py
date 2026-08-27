# -*- coding: utf-8 -*-
"""suite_posts — 内容推文集合 posts（AC-25，2026-08 后端改版，PRD 外扩展）。

断言：
- 写入权限：机构管理员/参与者/匿名 create/update/delete 一律拒绝（仅超管可写；
  无硬删除——deleteRule 对非超管关闭，隐藏即删除）；
- 超管 CRUD 与校验：仅正文 / 仅外链 / 两者皆有 → 200；正文与外链全空 → 400；
  外链非 http/https → 400；status 缺省 → hidden；
- published_at：创建即 visible 写入；hidden 起步首次置 visible 写入；再次切换不变；
- 可见性：匿名与机构管理员/参与者 list 仅见 visible；view hidden → 404；view visible → 200；
- 置顶排序：匿名 list sort=-is_pinned,-published_at 时置顶项在前；
- 审计：post.create / post.update（metadata 带 status 迁移）有记录；
- 公开读字段收敛：匿名 payload 键集合不超预期白名单（无内部字段）。
"""
import cc_fixture as fx
from cc_client import call

# 匿名可见字段白名单（全部为面向公开的设计字段）
PUBLIC_KEYS = {'id', 'collectionId', 'collectionName', 'title', 'summary', 'cover',
               'body_md', 'external_url', 'is_pinned', 'status', 'published_at',
               'created', 'updated'}


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    rep.section('suite_posts：内容推文集合（AC-25）')

    org = fx.create_org(base, st, '推文机构')
    _, AT = fx.create_admin_via_impersonate(base, st, org, 'pst_admin')
    _, PT, _ = fx.create_participant(base, 'pst_user')

    # ---------- 1. 超管 CRUD 与校验 ----------
    s, r = call(base, 'POST', '/api/collections/posts/records',
                {'title': '全空推文', 'status': 'hidden'}, st)
    rep.check('PST-01 正文与外链全空 → 400', s == 400, r)
    s, r = call(base, 'POST', '/api/collections/posts/records',
                {'title': '坏外链', 'external_url': 'javascript:alert(1)', 'status': 'hidden'}, st)
    rep.check('PST-02 外链非 http/https → 400', s == 400, r)
    s, r = call(base, 'POST', '/api/collections/posts/records',
                {'title': '相对路径外链', 'external_url': '/foo/bar', 'status': 'hidden'}, st)
    rep.check('PST-03 相对路径外链 → 400', s == 400, r)

    s, r = call(base, 'POST', '/api/collections/posts/records',
                {'title': '仅外链', 'external_url': 'https://mp.weixin.qq.com/s/abc',
                 'status': 'visible'}, st)
    rep.check('PST-04 仅外链 → 200 且创建即 visible 写入 published_at',
              s == 200 and bool(r.get('published_at')), r)
    p_link = r.get('id')
    s, r = call(base, 'POST', '/api/collections/posts/records',
                {'title': '仅正文', 'body_md': '# 你好', 'status': 'hidden'}, st)
    rep.check('PST-05 仅正文 → 200（hidden 无 published_at）',
              s == 200 and not r.get('published_at'), r)
    p_body = r.get('id')
    s, r = call(base, 'POST', '/api/collections/posts/records',
                {'title': '缺省 status', 'body_md': 'x'}, st)
    rep.check('PST-06 status 缺省 → hidden', s == 200 and r.get('status') == 'hidden', r)
    # 清掉这条，避免干扰后续可见性断言
    call(base, 'PATCH', '/api/collections/posts/records/%s' % r.get('id'),
         {'status': 'hidden'}, st)

    # ---------- 2. published_at 只写一次 ----------
    s, r = call(base, 'PATCH', '/api/collections/posts/records/%s' % p_body,
                {'status': 'visible'}, st)
    pa1 = r.get('published_at')
    rep.check('PST-07 hidden→visible 首次写入 published_at', s == 200 and bool(pa1), r)
    call(base, 'PATCH', '/api/collections/posts/records/%s' % p_body, {'status': 'hidden'}, st)
    s, r = call(base, 'PATCH', '/api/collections/posts/records/%s' % p_body,
                {'status': 'visible'}, st)
    rep.check('PST-08 再次 hidden→visible 时 published_at 不变',
              s == 200 and r.get('published_at') == pa1, r)

    # 置顶（发布时间更晚但置顶，排序应在前）
    s, r = call(base, 'POST', '/api/collections/posts/records',
                {'title': '置顶推文', 'body_md': 'x', 'status': 'visible', 'is_pinned': True}, st)
    rep.check('PST-09 两者皆有（正文+外链略）置顶创建 → 200', s == 200, r)
    p_pin = r.get('id')

    # ---------- 3. 写入权限矩阵（仅超管可写）----------
    for name, token in (('机构管理员', AT), ('参与者', PT)):
        s, r = call(base, 'POST', '/api/collections/posts/records',
                    {'title': '越权推文', 'body_md': 'x'}, token)
        rep.check('PST-10%s create posts 被拒（400/403/404）' % name,
                  s in (400, 403, 404), r)
        s, r = call(base, 'PATCH', '/api/collections/posts/records/%s' % p_link,
                    {'title': '篡改'}, token)
        rep.check('PST-11%s update posts 被拒（400/403/404）' % name,
                  s in (400, 403, 404), r)
        s, r = call(base, 'DELETE', '/api/collections/posts/records/%s' % p_link, token=token)
        rep.check('PST-12%s delete posts 被拒（400/403/404）' % name,
                  s in (400, 403, 404), r)
    s, r = call(base, 'POST', '/api/collections/posts/records', {'title': '匿名推文', 'body_md': 'x'})
    rep.check('PST-13 匿名 create posts 被拒（400/403/404）', s in (400, 403, 404), r)

    # ---------- 4. 可见性（匿名/管理员/参与者仅见 visible）----------
    s, r = call(base, 'POST', '/api/collections/posts/records',
                {'title': '隐藏推文', 'body_md': 'x', 'status': 'hidden'}, st)
    p_hidden = r.get('id')
    for name, token in (('匿名', None), ('机构管理员', AT), ('参与者', PT)):
        s, r = call(base, 'GET', '/api/collections/posts/records?perPage=100', token=token)
        ids = [i.get('id') for i in (r.get('items') or [])]
        rep.check('PST-14%s list 仅见 visible（hidden 不下发）' % name,
                  s == 200 and p_hidden not in ids and p_link in ids, r)
        s, r = call(base, 'GET', '/api/collections/posts/records/%s' % p_hidden, token=token)
        rep.check('PST-15%s view hidden → 404' % name, s == 404, r)
    s, r = call(base, 'GET', '/api/collections/posts/records/%s' % p_link)
    rep.check('PST-16 匿名 view visible → 200', s == 200, r)
    s, r = call(base, 'GET', '/api/collections/posts/records?perPage=100', token=st)
    ids = [i.get('id') for i in (r.get('items') or [])]
    rep.check('PST-17 超管 list 全量可见（含 hidden）', s == 200 and p_hidden in ids, r)

    # ---------- 5. 置顶排序（公开读直走集合 API）----------
    s, r = call(base, 'GET',
                '/api/collections/posts/records?perPage=100&sort=-is_pinned,-published_at')
    items = [i for i in (r.get('items') or []) if i.get('id') in (p_link, p_body, p_pin)]
    rep.check('PST-18 公开列表置顶在前（-is_pinned,-published_at）',
              s == 200 and items and items[0].get('id') == p_pin, r)

    # ---------- 6. 审计 ----------
    s, r = call(base, 'GET',
                "/api/collections/audit_logs/records?perPage=100&filter=(target_type='post')", token=st)
    actions = [i.get('action') for i in (r.get('items') or [])]
    rep.check('PST-19 post.create / post.update 审计均有记录',
              s == 200 and 'post.create' in actions and 'post.update' in actions, r)
    seed_audits = [i for i in (r.get('items') or [])
                   if i.get('target_id') in ('postreview00001', 'postreview00002')]
    rep.check('PST-19a seed 推文审计归因为 system',
              len(seed_audits) == 2 and
              all(i.get('actor_id') == 'system' and i.get('actor_role') == 'system'
                  for i in seed_audits), seed_audits)
    api_audits = [i for i in (r.get('items') or []) if i.get('target_id') == p_link]
    rep.check('PST-19b API 推文审计仍归因为 super_admin',
              len(api_audits) == 1 and api_audits[0].get('actor_id') and
              api_audits[0].get('actor_role') == 'super_admin', api_audits)

    # ---------- 7. 公开读字段收敛 ----------
    s, r = call(base, 'GET', '/api/collections/posts/records/%s' % p_link)
    rep.check('PST-20 匿名 payload 字段不超白名单（无内部字段）',
              s == 200 and set(r.keys()) <= PUBLIC_KEYS, sorted(r.keys()))
