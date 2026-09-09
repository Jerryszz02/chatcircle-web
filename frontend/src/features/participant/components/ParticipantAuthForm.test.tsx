import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllSessions, makeTestToken, stubApi, unstubApi } from '../../../test/mockApi';
import { ParticipantAuthForm } from './ParticipantAuthForm';

/**
 * 存量用户名登录组件测试（AC-06 前端侧）。
 * 覆盖：用户名规则客户端校验（非法不发起请求）、小写归一化提交、
 * 服务端错误（错误密码/限流）原样展示。
 */
describe('ParticipantAuthForm 用户名密码单框', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('用户名非法：展示规则错误且不发起请求', async () => {
    const mock = stubApi({});
    const onSuccess = vi.fn();
    render(<ParticipantAuthForm onSuccess={onSuccess} />);

    fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText(/密码/), { target: { value: '12345678' } });
    fireEvent.click(screen.getByRole('button', { name: '继续' }));

    expect(await screen.findByText('用户名需为 4–20 位')).toBeInTheDocument();
    expect(mock.calls).toHaveLength(0);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('合法输入：小写归一化后调用认证端点并触发 onSuccess', async () => {
    const mock = stubApi({
      'POST /api/cc/auth/participant': {
        body: {
          token: makeTestToken(),
          record: { id: 'p1', username: 'test_user', collectionName: 'participant_accounts' },
        },
      },
    });
    const onSuccess = vi.fn();
    render(<ParticipantAuthForm onSuccess={onSuccess} />);

    fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: 'Test_User ' } });
    fireEvent.change(screen.getByLabelText(/密码/), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: '继续' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(mock.calls).toHaveLength(1);
    expect(mock.bodyOf(0)).toEqual({ identity_type: 'username', username: 'test_user', password: 'password123' });
  });

  it('错误密码：展示服务端文案（不建号语义由服务端保证，AC-06）', async () => {
    stubApi({
      'POST /api/cc/auth/participant': {
        status: 400,
        body: { message: '密码错误，请确认后重试', data: {} },
      },
    });
    render(<ParticipantAuthForm onSuccess={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: 'exist_user' } });
    fireEvent.change(screen.getByLabelText(/密码/), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: '继续' }));

    expect(await screen.findByText('密码错误，请确认后重试')).toBeInTheDocument();
  });

  it('报名链路形态：展示隐私提示语（PRD §11.1 原文，security-privacy §6）', () => {
    stubApi({});
    render(<ParticipantAuthForm showPrivacyNotice onSuccess={vi.fn()} />);
    expect(screen.getByText(/不包含真实姓名、手机号或常用社交账号/)).toBeInTheDocument();
  });
});
