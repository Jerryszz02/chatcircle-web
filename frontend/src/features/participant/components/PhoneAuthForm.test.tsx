import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllSessions, makeTestToken, stubApi, unstubApi } from '../../../test/mockApi';
import { participantAuth } from '../../../shared/auth';
import { PhoneAuthForm } from './PhoneAuthForm';

describe('PhoneAuthForm 手机号验证码入口', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('未同意隐私说明时不请求验证码', async () => {
    const mock = stubApi({});
    render(<PhoneAuthForm onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: /^手机号/ }), { target: { value: '13812345678' } });
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
    expect(await screen.findByText('请阅读并同意隐私说明后继续')).toBeInTheDocument();
    expect(mock.calls).toHaveLength(0);
  });

  it('请求并验证后保存白名单账号会话', async () => {
    const mock = stubApi({
      'POST /api/cc/auth/participant/request-code': {
        body: { contract_version: '2026-08-28.t0-v1', accepted: true, challenge_id: 'ch1', expires_in_seconds: 300, retry_after_seconds: 60 },
      },
      'POST /api/cc/auth/participant/verify-code': {
        body: {
          contract_version: '2026-08-28.t0-v1', token: makeTestToken(), created: true,
          record: { id: 'p1', collectionId: 'participants', collectionName: 'participant_accounts', status: 'active', phone_masked: '+86 138****5678', phone_migration_status: 'phone_bound' },
        },
      },
    });
    const onSuccess = vi.fn();
    render(<PhoneAuthForm onSuccess={onSuccess} />);
    fireEvent.change(screen.getByRole('textbox', { name: /^手机号/ }), { target: { value: '138 1234 5678' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
    expect(await screen.findByRole('textbox', { name: /^验证码/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: /^验证码/ }), { target: { value: '246810' } });
    fireEvent.click(screen.getByRole('button', { name: '登录 / 注册' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(mock.bodyOf(0)).toEqual({
      phone: '+8613812345678', purpose: 'login_or_register', privacy_notice_version: '2026-09-05.v1',
    });
    expect(mock.bodyOf(1)).toEqual({
      phone: '+8613812345678', challenge_id: 'ch1', code: '246810', privacy_notice_version: '2026-09-05.v1',
    });
    expect(participantAuth.record).toMatchObject({ id: 'p1', phone_migration_status: 'phone_bound' });
    expect(participantAuth.record).not.toHaveProperty('username');
  });
});
