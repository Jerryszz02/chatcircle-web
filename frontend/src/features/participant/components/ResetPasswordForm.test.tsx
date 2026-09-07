import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllSessions, makeTestToken, stubApi, unstubApi } from '../../../test/mockApi';
import { participantAuth } from '../../../shared/auth';
import { ResetPasswordForm } from './ResetPasswordForm';

describe('ResetPasswordForm 手机号找回密码', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('请求验证码 → 重置密码并登录', async () => {
    const mock = stubApi({
      'POST /api/cc/auth/participant/request-code': {
        body: {
          contract_version: '2026-08-28.t0-v1',
          accepted: true,
          challenge_id: 'ch-reset',
          expires_in_seconds: 300,
          retry_after_seconds: 60,
        },
      },
      'POST /api/cc/auth/participant/reset-password': {
        body: {
          contract_version: '2026-08-28.t0-v1',
          token: makeTestToken(),
          record: {
            id: 'p1',
            collectionId: 'participants',
            collectionName: 'participant_accounts',
            status: 'active',
            phone_masked: '+86 138****5678',
            phone_migration_status: 'phone_bound',
          },
        },
      },
    });
    const onSuccess = vi.fn();
    render(<ResetPasswordForm onSuccess={onSuccess} />);
    fireEvent.change(screen.getByRole('textbox', { name: /^手机号/ }), {
      target: { value: '13812345678' },
    });
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));

    expect(await screen.findByRole('textbox', { name: /^验证码/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: /^验证码/ }), {
      target: { value: '246810' },
    });
    fireEvent.change(screen.getByLabelText(/^新密码/), { target: { value: 'newsecret1' } });
    fireEvent.change(screen.getByLabelText(/^确认新密码/), { target: { value: 'newsecret1' } });
    fireEvent.click(screen.getByRole('button', { name: '重置密码并登录' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(mock.bodyOf(0)).toEqual({ phone: '+8613812345678', purpose: 'reset_password' });
    expect(mock.bodyOf(1)).toEqual({
      phone: '+8613812345678',
      challenge_id: 'ch-reset',
      code: '246810',
      new_password: 'newsecret1',
    });
    expect(participantAuth.record).toMatchObject({ id: 'p1' });
  });

  it('两次新密码不一致时不提交', async () => {
    const mock = stubApi({
      'POST /api/cc/auth/participant/request-code': {
        body: {
          contract_version: '2026-08-28.t0-v1',
          accepted: true,
          challenge_id: 'ch-reset',
          expires_in_seconds: 300,
          retry_after_seconds: 60,
        },
      },
    });
    render(<ResetPasswordForm onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: /^手机号/ }), {
      target: { value: '13812345678' },
    });
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
    await screen.findByRole('textbox', { name: /^验证码/ });
    fireEvent.change(screen.getByRole('textbox', { name: /^验证码/ }), {
      target: { value: '246810' },
    });
    fireEvent.change(screen.getByLabelText(/^新密码/), { target: { value: 'newsecret1' } });
    fireEvent.change(screen.getByLabelText(/^确认新密码/), { target: { value: 'newsecret2' } });
    fireEvent.click(screen.getByRole('button', { name: '重置密码并登录' }));
    expect(screen.getByText('两次输入的密码不一致')).toBeInTheDocument();
    // 只发过 request-code 一次请求
    expect(mock.calls).toHaveLength(1);
  });
});
