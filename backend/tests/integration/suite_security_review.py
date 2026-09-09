"""2026-09-09 security regressions against the real PocketBase API."""
import os
import time
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from cc_client import call, biz_code
import cc_fixture as fx
from suite_phone_auth import request_code, register, MOCK_CODE, PRIVACY_VERSION
from suite_pairings import _realtime_client_id


def run(ctx):
    _phone(ctx)
    _disabled_sessions(ctx)
    _export_capacity(ctx)
    _sensitive_shadow(ctx)


def _phone(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    rep.section('Security review: phone concurrency and identity')
    phone = '13800009001'
    status, sent = request_code(base, phone, 'register', device='security-fifth')
    assert status == 200, sent
    cid = sent['challenge_id']
    for _ in range(4):
        status, result = register(base, phone, 'security_fifth', cid, code='000000')
        assert status == 400, result
    status, result = register(base, phone, 'security_fifth', cid)
    rep.check('SEC-F04 fifth reserved attempt can succeed', status == 200, result)
    _, saved = call(base, 'GET', '/api/collections/participant_phone_challenges/records/' + cid, token=st)
    rep.check('SEC-F04 fifth success consumed with count five',
              saved.get('attempt_count') == 5 and saved.get('status') == 'consumed', saved)

    phone = '13800009002'
    _, sent = request_code(base, phone, 'register', device='security-concurrent')
    cid = sent['challenge_id']
    barrier = threading.Barrier(16)
    def wrong(_):
        barrier.wait()
        return call(base, 'POST', '/api/cc/auth/participant/register', {
            'phone': phone, 'username': 'security_concurrent', 'password': 'secret123',
            'challenge_id': cid, 'code': '000000', 'privacy_notice_version': PRIVACY_VERSION,
        }, headers={'X-CC-Mock-Verify-Delay': '250'})
    with ThreadPoolExecutor(max_workers=15) as pool:
        futures = [pool.submit(wrong, i) for i in range(15)]
        barrier.wait()
        results = [f.result() for f in futures]
    _, saved = call(base, 'GET', '/api/collections/participant_phone_challenges/records/' + cid, token=st)
    rep.check('SEC-F04 concurrent verification reserves at most five attempts',
              saved.get('attempt_count') == 5 and saved.get('status') == 'failed'
              and all(s in (400, 429) for s, _ in results), [saved, results])
    log_path = os.environ.get('CC_IT_SERVE_LOG')
    assert log_path, 'runner must expose the mock provider log path'
    logged = [line for line in Path(log_path).read_text().splitlines()
              if 'cc_sms_mock_verify' in line and cid in line]
    rep.check('SEC-F04 actual mock provider invoked exactly five times', len(logged) == 5, len(logged))

    phone = '13800009003'
    _, sent = request_code(base, phone, 'register', device='security-interleave')
    cid = sent['challenge_id']
    def submit(code, delay):
        return call(base, 'POST', '/api/cc/auth/participant/register', {
            'phone': phone, 'username': 'security_interleave', 'password': 'secret123',
            'challenge_id': cid, 'code': code, 'privacy_notice_version': PRIVACY_VERSION,
        }, headers={'X-CC-Mock-Verify-Delay': str(delay)})
    with ThreadPoolExecutor(max_workers=5) as pool:
        late = [pool.submit(submit, '000000', 750) for _ in range(4)]
        time.sleep(0.15)
        success = pool.submit(submit, MOCK_CODE, 0).result()
        failed = [f.result() for f in late]
    _, saved = call(base, 'GET', '/api/collections/participant_phone_challenges/records/' + cid, token=st)
    rep.check('SEC-F04 delayed failures cannot reverse consumed state',
              success[0] == 200 and saved.get('status') == 'consumed'
              and saved.get('attempt_count') == 5, [success, failed, saved])

    phone = '13800009004'
    _, sent = request_code(base, phone, 'register', device='security-timeout')
    cid = sent['challenge_id']
    status, error = register(base, phone, 'security_timeout', cid, code='99999999')
    _, saved = call(base, 'GET', '/api/collections/participant_phone_challenges/records/' + cid, token=st)
    rep.check('SEC-F04 provider failure consumes one attempt and allows retry',
              status == 503 and saved.get('attempt_count') == 1 and saved.get('status') == 'sent', [error, saved])
    status, result = register(base, phone, 'security_timeout', cid)
    rep.check('SEC-F04 retry after provider failure succeeds', status == 200, result)

    # A username intentionally conflicts with another account's real bound phone.
    numeric_name = '13800009001'
    _, sent = request_code(base, '13800009005', 'register', device='security-numeric')
    status, numeric = register(base, '13800009005', numeric_name, sent['challenge_id'])
    assert status == 200, numeric
    for identity_type, field, value, expected in (
        ('username', 'username', numeric_name, numeric['record']['id']),
        ('phone', 'phone', '13800009005', numeric['record']['id']),
    ):
        status, result = call(base, 'POST', '/api/cc/auth/participant',
                              {'identity_type': identity_type, field: value, 'password': 'secret123'})
        rep.check('SEC-F06 explicit %s resolves numeric username deterministically' % identity_type,
                  status == 200 and result.get('record', {}).get('id') == expected, result)
    status, result = call(base, 'POST', '/api/cc/auth/participant',
                          {'identity_type': 'phone', 'phone': numeric_name, 'password': 'secret123'})
    rep.check('SEC-F06 conflicting phone resolves its own account without fallback',
              status == 200 and result.get('record', {}).get('id') != numeric['record']['id'], result)

    results = [request_code(base, '138000091%02d' % i, 'register', device='security-shared-%d' % i)[0]
               for i in range(30)]
    rep.check('SEC-F05 shared public IP supports 30 distinct synthetic attendees', all(s == 200 for s in results), results)
    devices = [request_code(base, '138000092%02d' % i, 'register', device='security-one-device')[0]
               for i in range(6)]
    rep.check('SEC-F05 single device still limited at six sends', devices == [200] * 5 + [429], devices)


def _disabled_sessions(ctx):
    base, st, rep, fields = ctx['base'], ctx['st'], ctx['rep'], ctx['fields']
    rep.section('Security review: disabled old sessions')
    org = fx.create_org(base, st, '安全停用机构')
    aid, at = fx.create_admin_via_impersonate(base, st, org, 'sec_disabled_admin')
    pid, pt, _ = fx.create_participant(base, 'sec_disabled_user')
    act = fx.create_activity(base, at, org, 'CC_IT_SEC_DISABLED', '停用验证', fields=fx.nick_field_cfg(fields))
    reg = fx.register(base, pt, act, 'speaker', fx.field_answers(fields, 'security'))
    reg_path = '/api/collections/registrations/records/' + reg
    rep.check('SEC-F02 active admin and participant can read registration',
              call(base, 'GET', reg_path, token=at)[0] == 200 and call(base, 'GET', reg_path, token=pt)[0] == 200)
    call(base, 'PATCH', '/api/collections/participant_accounts/records/' + pid, {'status': 'disabled'}, st)
    rep.check('SEC-F02 disabled participant old token cannot read or update',
              call(base, 'GET', reg_path, token=pt)[0] == 404
              and call(base, 'PATCH', '/api/collections/participant_accounts/records/' + pid,
                       {'emailVisibility': True}, pt)[0] in (400, 403, 404))
    call(base, 'PATCH', '/api/collections/participant_accounts/records/' + pid, {'status': 'active'}, st)
    rep.check('SEC-F02 reactivated participant old token follows active policy',
              call(base, 'GET', reg_path, token=pt)[0] == 200)
    for collection, target, label in (('admin_accounts', aid, 'admin'), ('organizations', org, 'organization')):
        stream, client_id = _realtime_client_id(base)
        status, _ = call(base, 'POST', '/api/realtime',
                         {'clientId': client_id, 'subscriptions': ['registrations/' + reg]}, at)
        assert status in (200, 204), status
        call(base, 'PATCH', '/api/collections/%s/records/%s' % (collection, target), {'status': 'disabled'}, st)
        rep.check('SEC-F02 disabled %s old token direct read/write rejected' % label,
                  call(base, 'GET', reg_path, token=at)[0] == 404
                  and call(base, 'PATCH', '/api/collections/activities/records/' + act,
                           {'title': 'unauthorized'}, at)[0] in (400, 403, 404))
        status, listing = call(base, 'GET', '/api/collections/registrations/records?expand=participant_id', token=at)
        rep.check('SEC-F02 disabled %s list/expand returns no records' % label,
                  status == 200 and listing.get('items') == [], listing)
        status, result = call(base, 'GET', '/api/cc/activities/%s/live-summary' % act, token=at)
        rep.check('SEC-F02 disabled %s custom endpoint rejected' % label, status == 403, result)
        call(base, 'PATCH', reg_path, {'status_reason': 'realtime guard ' + label}, st)
        received = b''
        try:
            stream.fp.raw._sock.settimeout(0.3)
            received = stream.readline()
        except (TimeoutError, OSError):
            pass
        finally:
            stream.close()
        rep.check('SEC-F02 disabled %s receives no record event on existing subscription' % label,
                  not received, received)
        call(base, 'PATCH', '/api/collections/%s/records/%s' % (collection, target), {'status': 'active'}, st)
        rep.check('SEC-F02 reactivated %s can read again' % label, call(base, 'GET', reg_path, token=at)[0] == 200)


def _export_capacity(ctx):
    from suite_exports_v2 import _base_selection
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    rep.section('Security review: persistent export capacity')
    org = fx.create_org(base, st, '并发导出机构')
    _, at = fx.create_admin_via_impersonate(base, st, org, 'sec_export_admin')
    act = fx.create_activity(base, at, org, 'CC_IT_SEC_EXPORT', '导出容量')
    selection = _base_selection(act)
    barrier = threading.Barrier(9)
    def export(_):
        barrier.wait()
        return call(base, 'POST', '/api/cc/exports', selection, at,
                    headers={'X-CC-Mock-Export-Delay': '800'})
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(export, i) for i in range(8)]
        barrier.wait()
        results = [f.result() for f in futures]
    successes = sum(status == 200 for status, _ in results)
    rep.check('SEC-F08 concurrent generation admits only two per organization',
              successes == 2 and all(s in (200, 429) for s, _ in results), results)
    for _ in range(10 - successes):
        status, result = call(base, 'POST', '/api/cc/exports', selection, at)
        assert status == 200, result
    status, result = call(base, 'POST', '/api/cc/exports', selection, at)
    rep.check('SEC-F08 hourly quota stops at ten committed reservations', status == 429, result)
    from urllib.parse import quote
    status, counters = call(base, 'GET', '/api/collections/cc_rate_counters/records?filter=' +
                            quote("key='cc_rl|export|quota|org|%s'" % org), token=st)
    rep.check('SEC-F08 hourly quota is persisted in database',
              status == 200 and len(counters['items'][0]['slots']) == 10, counters)
    status, counters = call(base, 'GET', '/api/collections/cc_rate_counters/records?filter=' +
                            quote("key='cc_rl|export|active|org|%s'" % org), token=st)
    rep.check('SEC-F08 completed requests release their own active slots',
              status == 200 and counters['items'][0]['slots'] == [], counters)
    other = fx.create_org(base, st, '独立导出机构')
    _, bt = fx.create_admin_via_impersonate(base, st, other, 'sec_export_other')
    other_act = fx.create_activity(base, bt, other, 'CC_IT_SEC_EXPORT_B', '独立导出')
    status, result = call(base, 'POST', '/api/cc/exports', _base_selection(other_act), bt)
    rep.check('SEC-F08 one organizations quota does not block another', status == 200, result)
    invalid = _base_selection(other_act)
    invalid['format'] = 'invalid'
    status, result = call(base, 'POST', '/api/cc/exports', invalid, bt)
    rep.check('SEC-F08 invalid request remains rejected', status == 400, result)
    _, counters = call(base, 'GET', '/api/collections/cc_rate_counters/records?filter=' +
                        quote("key='cc_rl|export|active|org|%s'" % other), token=st)
    rep.check('SEC-F08 failing requests release active slots', counters['items'][0]['slots'] == [], counters)


def _sensitive_shadow(ctx):
    from suite_exports_v2 import _base_selection, _unzip, _xlsx_sheet_names
    from urllib.parse import quote
    base, st, rep, fields = ctx['base'], ctx['st'], ctx['rep'], ctx['fields']
    rep.section('Security review: sensitive historical field shadow')
    org = fx.create_org(base, st, '姓名敏感导出机构', allow_sensitive=False)
    _, at = fx.create_admin_via_impersonate(base, st, org, 'sec_shadow_admin')
    act = fx.create_activity(base, at, org, 'CC_IT_SEC_SHADOW', '历史姓名', fields=fx.nick_field_cfg(fields))
    _, pt, _ = fx.create_participant(base, 'sec_shadow_user')
    fx.register(base, pt, act, 'speaker', [
        {'field_def_id': fields['nickname'], 'value': 'public_nickname'},
        {'field_def_id': fields['FULL_NAME'], 'value': 'historic-sensitive-full-name'},
    ])
    status, definition = call(base, 'POST', '/api/collections/registration_field_defs/records', {
        'organization_id': org, 'field_code': 'FULL_NAME', 'field_type': 'text',
        'label': '非敏感同码展示', 'source_type': 'custom', 'is_sensitive': False, 'status': 'active'}, st)
    assert status == 200, definition
    selected = _base_selection(act, columns={'registration_field_codes': ['FULL_NAME']})
    status, preview = call(base, 'POST', '/api/cc/exports/preview', selected, at)
    rep.check('SEC-F03 non-sensitive shadow cannot downgrade historical platform name',
              status == 200 and preview.get('requires_sensitive_export') is True, preview)
    selected['confirm_sensitive'] = True
    status, result = call(base, 'POST', '/api/cc/exports', selected, at)
    rep.check('SEC-F03 organization switch blocks confirmed sensitive shadow export',
              status == 403 and biz_code(result) == 'sensitive_export_disabled', result)
    call(base, 'PATCH', '/api/collections/organizations/records/' + org, {'allow_sensitive_export': True}, st)
    status, result = call(base, 'POST', '/api/cc/exports', selected, at)
    rep.check('SEC-F03 allowed and confirmed historical sensitive export succeeds', status == 200, result)
    assert status == 200, result
    job = result['export_job_id']
    status, blob = call(base, 'GET', '/api/cc/exports/%s/download' % job, token=at, raw=True)
    files = _unzip(blob)
    sheets = _xlsx_sheet_names(files)
    text = files['xl/worksheets/sheet%d.xml' % (sheets.index('registrations') + 1)].decode()
    rep.check('SEC-F03 authorized export contains historical platform definition answer',
              status == 200 and 'historic-sensitive-full-name' in text)
    _, audit = call(base, 'GET', '/api/collections/audit_logs/records?filter=' +
                    quote("target_id='%s' && action='export.sensitive'" % job), token=st)
    rep.check('SEC-F03 audit records sensitive selection and confirmation',
              len(audit['items']) == 1 and audit['items'][0]['metadata'].get('requires_sensitive_export') is True
              and audit['items'][0]['metadata'].get('confirm_sensitive') is True, audit)
