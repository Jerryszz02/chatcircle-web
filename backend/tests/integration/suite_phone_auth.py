# -*- coding: utf-8 -*-
"""T1 手机号验证码登录、存量绑定、换绑与安全边界。"""
from concurrent.futures import ThreadPoolExecutor

from cc_client import biz_code, call
import cc_fixture as fx


PRIVACY_VERSION = '2026-09-05.v1'
MOCK_CODE = '246810'


def request_code(base, phone, purpose='login_or_register', token=None, device='phone-it-device'):
    body = {'phone': phone, 'purpose': purpose}
    if purpose == 'login_or_register':
        body['privacy_notice_version'] = PRIVACY_VERSION
    return call(base, 'POST', '/api/cc/auth/participant/request-code', body, token,
                headers={'X-CC-Device-Session': device})


def verify(base, phone, challenge_id, code=MOCK_CODE):
    return call(base, 'POST', '/api/cc/auth/participant/verify-code', {
        'phone': phone, 'challenge_id': challenge_id, 'code': code,
        'privacy_notice_version': PRIVACY_VERSION,
    })


def challenge_template_marker(base, st, challenge_id):
    """读 mock challenge 的模板选择标记（provider_request_id，仅含场景名，不含手机号/验证码/密钥）。"""
    status, body = call(base, 'GET',
                        '/api/collections/participant_phone_challenges/records/%s' % challenge_id,
                        token=st)
    assert status == 200, '读 challenge 失败：%s' % body
    return body.get('provider_request_id') or ''


def run(ctx):
    base, st, rep = ctx['base'], ctx['st'], ctx['rep']
    rep.section('T1 手机号认证')

    status, body = call(base, 'POST', '/api/cc/auth/participant/request-code', {
        'phone': '123', 'purpose': 'login_or_register',
        'privacy_notice_version': PRIVACY_VERSION,
    })
    rep.check('非法手机号被拒绝', status == 400 and biz_code(body) == 'invalid_phone', body)

    status, body = call(base, 'POST', '/api/cc/auth/participant/request-code', {
        'phone': '13800002001', 'purpose': 'login_or_register',
    })
    rep.check('登录注册前强制隐私版本', status == 400 and biz_code(body) == 'privacy_notice_required', body)

    status, body = call(base, 'POST', '/api/cc/auth/participant/request-code', {
        'phone': '13800002001', 'purpose': 'unknown_purpose',
        'privacy_notice_version': PRIVACY_VERSION,
    })
    rep.check('未知短信用途被拒绝且不回落其他模板', status == 400 and biz_code(body) == 'code_invalid', body)

    phone = '13800002002'
    status, sent = request_code(base, phone, device='phone-it-signup')
    rep.check('发送验证码返回统一 challenge 形状', status == 200 and sent.get('accepted') is True and
              sent.get('expires_in_seconds') == 300, sent)
    rep.check('登录/注册选择登录模板', status == 200 and
              challenge_template_marker(base, st, sent.get('challenge_id')).startswith('mock-login_register-'),
              sent)
    status, auth = verify(base, phone, sent.get('challenge_id'))
    record = auth.get('record') or {}
    rep.check('新手机号创建并登录', status == 200 and auth.get('created') is True and
              record.get('phone_migration_status') == 'phone_bound', auth)
    rep.check('手机号认证响应不泄露内部身份字段',
              not any(key in record for key in ('username', 'phone_e164', 'phone_lookup_hash')), record)
    participant_id = record.get('id')

    status, reused = verify(base, phone, sent.get('challenge_id'))
    rep.check('challenge 只能消费一次', status == 409 and biz_code(reused) == 'challenge_consumed', reused)

    status, sent_again = request_code(base, phone, device='phone-it-login')
    status, auth_again = verify(base, phone, sent_again.get('challenge_id'))
    rep.check('已有手机号幂等登录同一账号', status == 200 and auth_again.get('created') is False and
              auth_again.get('record', {}).get('id') == participant_id, auth_again)

    legacy_id, legacy_token, _ = fx.create_participant(base, 't1_legacy_user')
    bind_phone = '13800002003'
    status, bind_sent = request_code(base, bind_phone, 'bind_phone', legacy_token, 'phone-it-bind')
    rep.check('首次绑定选择绑定新手机号模板', status == 200 and
              challenge_template_marker(base, st, bind_sent.get('challenge_id')).startswith('mock-bind_new-'),
              bind_sent)
    status, bound = call(base, 'POST', '/api/cc/auth/participant/bind-phone', {
        'phone': bind_phone, 'challenge_id': bind_sent.get('challenge_id'), 'code': MOCK_CODE,
    }, legacy_token)
    rep.check('存量账号绑定保留 participant_id', status == 200 and
              bound.get('participant_id') == legacy_id and bound.get('phone_migration_status') == 'phone_bound', bound)

    conflict_id, conflict_token, _ = fx.create_participant(base, 't1_conflict_user')
    status, conflict_sent = request_code(base, bind_phone, 'bind_phone', conflict_token, 'phone-it-conflict')
    status, conflict = call(base, 'POST', '/api/cc/auth/participant/bind-phone', {
        'phone': bind_phone, 'challenge_id': conflict_sent.get('challenge_id'), 'code': MOCK_CODE,
    }, conflict_token)
    rep.check('手机号冲突不自动合并账号', status == 409 and biz_code(conflict) == 'phone_conflict', conflict)
    status, conflict_login = call(base, 'POST', '/api/cc/auth/participant', {
        'username': 't1_conflict_user', 'password': fx.PASSWORD,
    })
    rep.check('冲突账号标记待人工合并', status == 200 and
              conflict_login.get('record', {}).get('phone_migration_status') == 'merge_required' and
              conflict_login.get('record', {}).get('id') == conflict_id, conflict_login)

    new_phone = '13800002004'
    _, old_sent = request_code(base, bind_phone, 'change_phone', legacy_token, 'phone-it-change-old')
    _, new_sent = request_code(base, new_phone, 'change_phone', legacy_token, 'phone-it-change-new')
    rep.check('换绑旧号选择验证绑定手机号模板',
              challenge_template_marker(base, st, old_sent.get('challenge_id')).startswith('mock-verify_bound-'),
              old_sent)
    rep.check('换绑新号选择绑定新手机号模板',
              challenge_template_marker(base, st, new_sent.get('challenge_id')).startswith('mock-bind_new-'),
              new_sent)
    status, changed = call(base, 'POST', '/api/cc/auth/participant/change-phone', {
        'phone': new_phone, 'challenge_id': new_sent.get('challenge_id'), 'code': MOCK_CODE,
        'verification_method': 'old_phone',
        'old_phone_challenge_id': old_sent.get('challenge_id'), 'old_phone_code': MOCK_CODE,
    }, legacy_token)
    rep.check('旧号和新号双验证码原子换绑', status == 200 and
              changed.get('participant_id') == legacy_id and changed.get('phone_masked') == '+86 138****2004', changed)
    _, new_login_sent = request_code(base, new_phone, device='phone-it-changed-login')
    status, new_login = verify(base, new_phone, new_login_sent.get('challenge_id'))
    rep.check('换绑后新手机号登录原账号', status == 200 and
              new_login.get('record', {}).get('id') == legacy_id, new_login)

    status, provider_fail = request_code(base, '13900000009', device='phone-it-provider-fail')
    rep.check('短信提供方失败使用稳定业务错误', status == 503 and
              biz_code(provider_fail) == 'provider_unavailable', provider_fail)

    concurrent_phone = '13800002005'
    _, concurrent_sent = request_code(base, concurrent_phone, device='phone-it-concurrent')
    challenge_id = concurrent_sent.get('challenge_id')
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: verify(base, concurrent_phone, challenge_id), range(2)))
    statuses = sorted(status for status, _ in results)
    rep.check('并发验证同一 challenge 仅一次成功', statuses == [200, 409], results)

    # 超管停用后，验证码仍按统一形状发送；验证阶段才返回停用状态，避免请求阶段枚举。
    disabled_phone = '13800002006'
    _, disabled_sent = request_code(base, disabled_phone, device='phone-it-disabled-create')
    _, disabled_auth = verify(base, disabled_phone, disabled_sent.get('challenge_id'))
    disabled_id = disabled_auth.get('record', {}).get('id')
    call(base, 'PATCH', '/api/collections/participant_accounts/records/%s' % disabled_id,
         {'status': 'disabled'}, st)
    status, disabled_sent2 = request_code(base, disabled_phone, device='phone-it-disabled-login')
    status, disabled = verify(base, disabled_phone, disabled_sent2.get('challenge_id'))
    rep.check('停用账号在验证后拒绝登录', status == 403 and biz_code(disabled) == 'account_disabled', disabled)
