import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllSessions, makeTestToken, stubApi, unstubApi } from '../../../test/mockApi';
import { participantAuth } from '../../../shared/auth';
import { RegisterForm } from './RegisterForm';

const AUTH_BODY = {
  contract_version: '2026-08-28.t0-v1',
  token: makeTestToken(),
  created: true,
  record: {
    id: 'p1',
    collectionId: 'participants',
    collectionName: 'participant_accounts',
    status: 'active',
    phone_masked: '+86 138****5678',
    phone_migration_status: 'phone_bound',
  },
};

function fillAccountFields() {
  fireEvent.change(screen.getByRole('textbox', { name: /^用户名/ }), {
    target: { value: 'New_User1' },
  });
  fireEvent.change(screen.getByLabelText(/^密码/), { target: { value: 'secret123' } });
  fireEvent.change(screen.getByLabelText(/^确认密码/), { target: { value: 'secret123' } });
  fireEvent.change(screen.getByRole('textbox', { name: /^手机号/ }), {
    target: { value: '13812345678' },
  });
}

describe('RegisterForm 用户名+密码+手机号注册', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('两次密码不一致时不请求验证码', () => {
    const mock = stubApi({});
    render(<RegisterForm onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: /^用户名/ }), {
      target: { value: 'new_user1' },
    });
    fireEvent.change(screen.getByLabelText(/^密码/), { target: { value: 'secret123' } });
    fireEvent.change(screen.getByLabelText(/^确认密码/), { target: { value: 'secret456' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^手机号/ }), {
      target: { value: '13812345678' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
    expect(screen.getByText('两次输入的密码不一致')).toBeInTheDocument();
    expect(mock.calls).toHaveLength(0);
  });

  it('完整流程：请求验证码 → 注册并登录', async () => {
    const mock = stubApi({
      'POST /api/cc/auth/participant/request-code': {
        body: {
          contract_version: '2026-08-28.t0-v1',
          accepted: true,
          challenge_id: 'ch-reg',
          expires_in_seconds: 300,
          retry_after_seconds: 60,
        },
      },
      'POST /api/cc/auth/participant/register': { body: AUTH_BODY },
    });
    const onSuccess = vi.fn();
    render(<RegisterForm onSuccess={onSuccess} />);
    fillAccountFields();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));

    expect(await screen.findByRole('textbox', { name: /^验证码/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: /^验证码/ }), {
      target: { value: '246810' },
    });
    fireEvent.click(screen.getByRole('button', { name: '注册并登录' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(mock.bodyOf(0)).toEqual({
      phone: '+8613812345678',
      purpose: 'register',
      privacy_notice_version: '2026-09-05.v1',
    });
    expect(mock.bodyOf(1)).toEqual({
      username: 'new_user1',
      password: 'secret123',
      phone: '+8613812345678',
      challenge_id: 'ch-reg',
      code: '246810',
      privacy_notice_version: '2026-09-05.v1',
    });
    expect(participantAuth.record).toMatchObject({ id: 'p1' });
  });
});
