# -*- coding: utf-8 -*-
"""suite_pairings — T2 现场编号、批量/迟到配对、释放调整、权限与审计。"""
import threading
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import cc_fixture as fx
from cc_client import biz_code, call


def _list(base, token, collection, flt='', sort=''):
    query = '?perPage=200'
    if flt:
        query += '&filter=' + quote(flt, safe="'()")
    if sort:
        query += '&sort=' + quote(sort)
    s, r = call(base, 'GET', '/api/collections/%s/records%s' % (collection, query), token=token)
    return s, r.get('items') or []


def _pairings(base, token, activity_id, status=None):
    flt = "activity_id='%s'" % activity_id
    if status:
        flt += " && status='%s'" % status
    return _list(base, token, 'activity_pairs', flt, 'pair_sequence')[1]


def _checkins(base, token, activity_id, role=None, status='valid'):
    flt = "activity_id='%s' && status='%s'" % (activity_id, status)
    if role:
        flt += " && onsite_role='%s'" % role
    return _list(base, token, 'checkins', flt, 'onsite_sequence')[1]


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    fields = ctx['fields']
    rep.section('suite_pairings：T2 现场编号/队列/释放调整/权限')

    # FULL_NAME 是 T1/T4 激活前的冻结标准字段；T2 本人快照只允许从它取搭档姓名。
    s, full_name = call(base, 'POST', '/api/collections/registration_field_defs/records', {
        'organization_id': '', 'field_code': 'FULL_NAME', 'field_type': 'text',
        'label': '姓名', 'source_type': 'standard', 'is_sensitive': True,
        # 全局默认保持 optional，避免测试字段意外改变其他既有活动；本 T2 活动在
        # form_config 中单独设 required=true，复现未来激活后的目标行为。
        'required_default': False, 'role_scope': 'both', 'status': 'active'}, st)
    assert s == 200, '创建 FULL_NAME fixture 失败：%s' % full_name
    full_name_id = full_name['id']

    org = fx.create_org(base, st, 'T2 配对机构')
    _, AT1 = fx.create_admin_via_impersonate(base, st, org, 'pair_admin_1')
    _, AT2 = fx.create_admin_via_impersonate(base, st, org, 'pair_admin_2')
    other_org = fx.create_org(base, st, 'T2 其他机构')
    _, OTHER_AT = fx.create_admin_via_impersonate(base, st, other_org, 'pair_other_admin')
    s, injected = call(base, 'POST', '/api/collections/activities/records', {
        'organization_id': org, 'activity_code': 'CC_IT_PAIR_INJECT', 'title': 'T2 注入守卫',
        'start_time': '2099-01-01 10:00:00.000Z', 'end_time': '2099-01-01 12:00:00.000Z',
        'status': 'draft', 'capacity_total': 2, 'capacity_speaker': 1, 'capacity_listener': 1,
        'registration_open': True,
        'pairing_started_at': '2099-01-01 09:00:00.000Z', 'pairing_started_by': 'injected',
        'onsite_locked_at': '2099-01-01 09:30:00.000Z', 'onsite_locked_by': 'injected',
        'next_speaker_sequence': 99, 'next_listener_sequence': 88,
    }, AT1)
    rep.check('PAIR-00 新活动忽略客户端注入的现场状态并强制从 1 开始',
              s == 200 and injected.get('next_speaker_sequence') == 1
              and injected.get('next_listener_sequence') == 1
              and not injected.get('pairing_started_at') and not injected.get('pairing_started_by')
              and not injected.get('onsite_locked_at') and not injected.get('onsite_locked_by'), injected)
    act = fx.create_activity(
        base, AT1, org, 'CC_IT_PAIR_01', 'T2 配对场',
        fields=[(fields['nickname'], True, True), (full_name_id, True, True)],
        caps=(20, 10, 10),
    )
    qr = fx.checkin_token(base, AT1, act)

    members = []
    for role, prefix, count in (('speaker', 'ps', 4), ('listener', 'pl', 3)):
        for index in range(1, count + 1):
            username = 'pair_%s%d' % (prefix, index)
            participant_id, token, _ = fx.create_participant(base, username)
            display_name = '%s姓名%d' % ('倾诉' if role == 'speaker' else '聆听', index)
            reg = fx.register(base, token, act, role, [
                {'field_def_id': fields['nickname'], 'value': username},
                {'field_def_id': full_name_id, 'value': display_name},
            ])
            fx.transition(base, AT1, reg, 'approved')
            members.append({
                'role': role, 'username': username, 'participant_id': participant_id,
                'token': token, 'registration_id': reg, 'display_name': display_name,
            })

    speakers = [m for m in members if m['role'] == 'speaker']
    listeners = [m for m in members if m['role'] == 'listener']
    call(base, 'POST', '/api/cc/activities/%s/checkin/open' % act, {}, AT1)

    # 两名同角色参与者并发签到：号码由数据库计数器决定，不依赖客户端时间或 ID。
    barrier = threading.Barrier(3)

    def concurrent_scan(member):
        barrier.wait()
        return fx.self_checkin(base, qr, member['token'])

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(concurrent_scan, speakers[0])
        second = pool.submit(concurrent_scan, speakers[1])
        barrier.wait()
        concurrent_results = [first.result(), second.result()]
    speaker_rows = _checkins(base, AT1, act, 'speaker')
    rep.check('PAIR-01 并发签到均成功且现场号唯一连续',
              all(item[0] == 200 for item in concurrent_results)
              and sorted(row.get('onsite_sequence') for row in speaker_rows) == [1, 2],
              [concurrent_results, speaker_rows])

    fx.self_checkin(base, qr, speakers[2]['token'])
    fx.self_checkin(base, qr, listeners[0]['token'])
    s, before = call(base, 'GET', '/api/cc/activities/%s/my-pairing' % act,
                     token=speakers[0]['token'])
    rep.check('PAIR-02 配对开始前本人只见现场号与 waiting_to_start',
              s == 200 and before.get('state') == 'waiting_to_start'
              and before.get('onsite_code', '').startswith('S'), before)

    # 两管理员并发首次开始配对：终态只有一组，另一请求幂等补齐空队列。
    start_barrier = threading.Barrier(3)

    def start_pairing(token):
        start_barrier.wait()
        return call(base, 'POST', '/api/cc/activities/%s/pairings/start' % act, {}, token)

    with ThreadPoolExecutor(max_workers=2) as pool:
        f1 = pool.submit(start_pairing, AT1)
        f2 = pool.submit(start_pairing, AT2)
        start_barrier.wait()
        start_results = [f1.result(), f2.result()]
    active = _pairings(base, AT1, act, 'active')
    rep.check('PAIR-03 两管理员并发开始配对不重复组号/不一人多配',
              all(item[0] == 200 for item in start_results) and len(active) == 1
              and active[0].get('pair_sequence') == 1,
              [start_results, active])
    s, repeated = call(base, 'POST', '/api/cc/activities/%s/pairings/start' % act, {}, AT1)
    rep.check('PAIR-04 重复开始幂等且不重排已有组',
              s == 200 and repeated.get('already_started') is True
              and repeated.get('created_pairs') == 0 and len(_pairings(base, AT1, act, 'active')) == 1,
              repeated)

    first_pair = active[0]
    member_by_id = {m['participant_id']: m for m in members}
    paired_speaker_checkin = next(
        row for row in speaker_rows + _checkins(base, AT1, act, 'speaker')
        if row['id'] == first_pair['speaker_checkin_id'])
    paired_speaker = member_by_id[paired_speaker_checkin['participant_id']]
    s, mine = call(base, 'GET', '/api/cc/activities/%s/my-pairing' % act,
                   token=paired_speaker['token'])
    rep.check('PAIR-05 本人快照只返 P/S/L 展示码与搭档本场 FULL_NAME',
              s == 200 and mine.get('state') == 'paired' and mine.get('pair_code') == 'P01'
              and (mine.get('partner') or {}).get('display_name') == listeners[0]['display_name']
              and listeners[0]['username'] not in str(mine), mine)

    # 迟到聆听者依次自动补配，已有 P01 不重排。
    fx.self_checkin(base, qr, listeners[1]['token'])
    fx.self_checkin(base, qr, listeners[2]['token'])
    active = _pairings(base, AT1, act, 'active')
    rep.check('PAIR-06 迟到者跨候选分页边界仍按队首自动补成 P02/P03',
              [row.get('pair_sequence') for row in active] == [1, 2, 3], active)

    # 第四名 speaker 等待；撤销 P01 speaker 后，锁定前搭档回队并自动与 S04 组成 P04。
    fx.self_checkin(base, qr, speakers[3]['token'])
    s, revoked = call(base, 'POST', '/api/cc/checkins/%s/revoke' % first_pair['speaker_checkin_id'],
                      {'reason': '锁定前签到撤销'}, AT1)
    active = _pairings(base, AT1, act, 'active')
    released = _pairings(base, AT1, act, 'released')
    rep.check('PAIR-07 锁定前撤销释放旧组、搭档回队且组号不复用',
              s == 200 and any(row['id'] == first_pair['id'] for row in released)
              and [row.get('pair_sequence') for row in active] == [2, 3, 4],
              [revoked, active, released])

    s, locked = call(base, 'POST', '/api/cc/activities/%s/onsite/lock' % act, {}, AT1)
    s2, locked_again = call(base, 'POST', '/api/cc/activities/%s/onsite/lock' % act, {}, AT2)
    rep.check('PAIR-08 现场锁定幂等并保留首次操作者',
              s == 200 and s2 == 200 and locked.get('already_locked') is False
              and locked_again.get('already_locked') is True
              and (locked.get('onsite') or {}).get('onsite_locked_by')
              == (locked_again.get('onsite') or {}).get('onsite_locked_by'),
              [locked, locked_again])

    # 被撤销参与者重签取得新号（不复用）；锁定后撤销 P04 只释放，不自动把两侧等待者拼组。
    s, resign = fx.self_checkin(base, qr, paired_speaker['token'])
    new_speaker_checkin = resign.get('checkin') or {}
    p04 = next(row for row in active if row.get('pair_sequence') == 4)
    call(base, 'POST', '/api/cc/checkins/%s/revoke' % p04['speaker_checkin_id'],
         {'reason': '锁定后现场调整'}, AT1)
    active_after_locked_revoke = _pairings(base, AT1, act, 'active')
    rep.check('PAIR-09 撤销后重签号码不复用，锁定后不自动调整',
              s == 200 and new_speaker_checkin.get('onsite_sequence') == 5
              and [row.get('pair_sequence') for row in active_after_locked_revoke] == [2, 3],
              [resign, active_after_locked_revoke])

    # 两管理员对同一目标并发调整：一个建立 P05，另一个读到同一 active pair，终态仍唯一。
    released_p04 = next(row for row in _pairings(base, AT1, act, 'released')
                        if row.get('pair_sequence') == 4)
    listener_checkin_id = released_p04['listener_checkin_id']
    reassign_body = {
        'speaker_checkin_id': new_speaker_checkin['id'],
        'listener_checkin_id': listener_checkin_id,
        'reason': '锁定后换组',
    }
    reassign_barrier = threading.Barrier(3)

    def reassign(token):
        reassign_barrier.wait()
        return call(base, 'POST', '/api/cc/activities/%s/pairings/reassign' % act,
                    reassign_body, token)

    with ThreadPoolExecutor(max_workers=2) as pool:
        r1 = pool.submit(reassign, AT1)
        r2 = pool.submit(reassign, AT2)
        reassign_barrier.wait()
        reassign_results = [r1.result(), r2.result()]
    pair_ids = [(item[1].get('pairing') or {}).get('id') for item in reassign_results]
    active = _pairings(base, AT1, act, 'active')
    rep.check('PAIR-10 并发/重复手工调整幂等且一人至多一个 active pair',
              all(item[0] == 200 for item in reassign_results)
              and len(set(pair_ids)) == 1 and len(active) == 3
              and max(row.get('pair_sequence') for row in active) == 5,
              [reassign_results, active])
    s, reassigned_mine = call(base, 'GET', '/api/cc/activities/%s/my-pairing' % act,
                              token=paired_speaker['token'])
    rep.check('PAIR-11 调整后本人状态为 reassigned 且显示新组号',
              s == 200 and reassigned_mine.get('state') == 'reassigned'
              and reassigned_mine.get('pair_code') == 'P05', reassigned_mine)

    # 已归档/已下架活动是终态历史，不得再释放并重建配对。
    close_status, _ = call(base, 'POST', '/api/cc/activities/%s/close' % act, {}, AT1)
    archive_status, _ = call(base, 'POST', '/api/cc/activities/%s/archive' % act, {}, AT1)
    s, finalized = call(base, 'POST', '/api/cc/activities/%s/pairings/reassign' % act,
                        reassign_body, AT1)
    rep.check('PAIR-12 已归档活动拒绝改组且不改写历史配对',
              close_status == 200 and archive_status == 200 and s == 400
              and biz_code(finalized) == 'pairing_unavailable'
              and len(_pairings(base, AT1, act, 'active')) == 3, finalized)

    # 权限：其他机构统一 404；参与者不能管理或直读 pair 集合，只能读本人快照。
    s, cross = call(base, 'POST', '/api/cc/activities/%s/pairings/start' % act, {}, OTHER_AT)
    s2, participant_manage = call(base, 'POST', '/api/cc/activities/%s/pairings/start' % act,
                                  {}, paired_speaker['token'])
    s3, participant_pairs = call(base, 'GET', '/api/collections/activity_pairs/records?perPage=100',
                                 token=paired_speaker['token'])
    rep.check('PAIR-13 跨机构 404，参与者管理 403 且直读 pair 集合为空',
              s == 404 and biz_code(cross) == 'not_found'
              and s2 == 403 and s3 == 200 and participant_pairs.get('totalItems') == 0,
              [cross, participant_manage, participant_pairs])

    # 审计：开始、自动补配、释放、调整与现场锁定都有服务端记录，reason 不丢失。
    _, audits = _list(base, st, 'audit_logs', "organization_id='%s'" % org, 'created')
    actions = [row.get('action') for row in audits]
    reassign_audits = [row for row in audits if row.get('action') == 'pairing.reassign']
    rep.check('PAIR-14 T2 状态变更审计完整且调整原因保留',
              all(action in actions for action in (
                  'pairing.start', 'pairing.auto', 'pairing.release', 'pairing.reassign', 'onsite.lock'))
              and any(row.get('reason') == '锁定后换组' for row in reassign_audits), actions)
