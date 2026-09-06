import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminEmailPage } from './AdminEmailPage';
import * as emailAuth from '../lib/emailAuth';
vi.mock('../lib/emailAuth', async (original) => ({
  ...(await original<typeof import('../lib/emailAuth')>()),
  requestAdminOTP: vi.fn(),
  verifyAdminOTP: vi.fn(),
  requestAdminEmail: vi.fn(),
  confirmAdminEmail: vi.fn(),
  resetAdminPassword: vi.fn(),
}));
function mount(mode: 'otp' | 'verify' | 'reset') {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<AdminEmailPage mode={mode} />} />
        <Route path="/admin/activities" element={<p>活动管理已登录</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});
describe('管理员邮箱入口', () => {
  it('校验邮箱并走 OTP 请求、确认、跳转', async () => {
    vi.mocked(emailAuth.requestAdminOTP).mockResolvedValue({ otpId: 'otp1' });
    mount('otp');
    fireEvent.click(screen.getByRole('button', { name: '发送邮件' }));
    expect(emailAuth.requestAdminOTP).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/注册邮箱/), { target: { value: 'admin@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '发送邮件' }));
    fireEvent.change(await screen.findByLabelText(/邮件验证码/), { target: { value: '12345678' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并登录' }));
    await screen.findByText('活动管理已登录');
    expect(emailAuth.verifyAdminOTP).toHaveBeenCalledWith('otp1', '12345678');
  });
  it('验证邮件 token 从地址栏移除且必须显式提交', async () => {
    window.history.replaceState(null, '', '/#token=verify-token');
    mount('verify');
    expect(window.location.hash).toBe('');
    expect(emailAuth.confirmAdminEmail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认验证邮箱' }));
    await waitFor(() => expect(emailAuth.confirmAdminEmail).toHaveBeenCalledWith('verify-token'));
    expect(await screen.findByRole('status')).toHaveTextContent('邮箱已验证');
  });
  it('重置密码校验两次输入，失效 token 错误可见', async () => {
    window.history.replaceState(null, '', '/#token=expired');
    vi.mocked(emailAuth.resetAdminPassword).mockRejectedValue(new Error('链接已失效'));
    mount('reset');
    fireEvent.change(screen.getByLabelText(/^新密码/), { target: { value: 'new-password' } });
    fireEvent.click(screen.getByRole('button', { name: '保存新密码' }));
    expect(emailAuth.resetAdminPassword).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/确认新密码/), { target: { value: 'new-password' } });
    fireEvent.click(screen.getByRole('button', { name: '保存新密码' }));
    await waitFor(() =>
      expect(emailAuth.resetAdminPassword).toHaveBeenCalledWith('expired', 'new-password', 'new-password'),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('链接已失效');
  });
});
