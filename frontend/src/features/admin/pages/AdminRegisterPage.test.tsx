import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllSessions, makeTestToken, stubApi, unstubApi } from '../../../test/mockApi';
import { AdminRegisterPage } from './AdminRegisterPage';

/**
 * 管理员邀请码注册页测试（FR-ORG-002/003、AC-02 前端侧）。
 * 覆盖：必填邮箱展示、邮箱归一化提交、非法/空邮箱不请求、密码不一致拦截、
 * 四字段 contract、注册成功自动登录并跳转管理端、后端邮件类错误 message 透传显示。
 */

function renderRegister() {
  return render(
    <MemoryRouter initialEntries={['/admin/register']}>
      <Routes>
        <Route path="/admin/register" element={<AdminRegisterPage />} />
        <Route path="/admin/activities" element={<div>ADMIN_ACTIVITIES_PAGE</div>} />
        <Route path="/" element={<div>HOME_PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 填入一份合法注册表单（邮箱/用户名故意带大小写与首尾空格，验证归一化）。 */
function fillValidForm() {
  fireEvent.change(screen.getByLabelText(/邀请码/), { target: { value: 'invite123' } });
  fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: 'AdminUser' } });
  fireEvent.change(screen.getByLabelText(/^邮箱/), { target: { value: '  Admin@Example.COM  ' } });
  fireEvent.change(screen.getByLabelText(/^密码/), { target: { value: 'password123' } });
  fireEvent.change(screen.getByLabelText(/确认密码/), { target: { value: 'password123' } });
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: '注册并登录' }));
}

describe('AdminRegisterPage 邀请码注册', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('展示必填邮箱字段（type=email、autoComplete=email、maxLength=254）', () => {
    stubApi({});
    renderRegister();
    const email = screen.getByRole('textbox', { name: /^邮箱/ });
    expect(email).toBeInTheDocument();
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'email');
    expect(email).toHaveAttribute('maxlength', '254');
    expect(email).toBeRequired();
  });

  it('合法邮箱 trim 并转小写后提交，四字段齐全', async () => {
    const mock = stubApi({
      'POST /api/cc/auth/admin-register': {
        body: { record: { id: 'a1', username: 'adminuser', collectionName: 'admin_accounts' } },
      },
      'POST /api/collections/admin_accounts/auth-with-password': {
        body: {
          token: makeTestToken(),
          record: { id: 'a1', username: 'adminuser', collectionName: 'admin_accounts' },
        },
      },
    });
    renderRegister();
    fillValidForm();
    submit();

    expect(await screen.findByText('ADMIN_ACTIVITIES_PAGE')).toBeInTheDocument();
    // 首个请求为注册：邮箱/用户名已 trim + 小写归一化，四字段齐全。
    const registerBody = mock.bodyOf(0) as Record<string, unknown>;
    expect(registerBody).toMatchObject({
      invite_code: 'invite123',
      username: 'adminuser',
      email: 'admin@example.com',
      password: 'password123',
    });
    expect(Object.keys(registerBody).sort()).toEqual(['email', 'invite_code', 'password', 'username']);
  });

  it('空邮箱不请求后端并提示', async () => {
    const mock = stubApi({});
    renderRegister();
    fireEvent.change(screen.getByLabelText(/邀请码/), { target: { value: 'invite123' } });
    fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: 'adminuser' } });
    fireEvent.change(screen.getByLabelText(/^密码/), {
      target: { value: 'password123' },
    });
    fireEvent.change(screen.getByLabelText(/确认密码/), {
      target: { value: 'password123' } });
    submit();

    expect(await screen.findByText('请输入有效的邮箱地址')).toBeInTheDocument();
    expect(mock.calls).toHaveLength(0);
  });

  it('非法邮箱不请求后端并提示', async () => {
    const mock = stubApi({});
    renderRegister();
    fireEvent.change(screen.getByLabelText(/邀请码/), { target: { value: 'invite123' } });
    fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: 'adminuser' } });
    fireEvent.change(screen.getByLabelText(/^邮箱/), { target: { value: 'admin@example' } });
    fireEvent.change(screen.getByLabelText(/^密码/), {
      target: { value: 'password123' },
    });
    fireEvent.change(screen.getByLabelText(/确认密码/), {
      target: { value: 'password123' } });
    submit();

    expect(await screen.findByText('请输入有效的邮箱地址')).toBeInTheDocument();
    expect(mock.calls).toHaveLength(0);
  });

  it('密码不一致仍被拦截且不请求后端', async () => {
    const mock = stubApi({});
    renderRegister();
    fireEvent.change(screen.getByLabelText(/邀请码/), { target: { value: 'invite123' } });
    fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: 'adminuser' } });
    fireEvent.change(screen.getByLabelText(/^邮箱/), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByLabelText(/^密码/), {
      target: { value: 'password123' },
    });
    fireEvent.change(screen.getByLabelText(/确认密码/), {
      target: { value: 'password1234' } });
    submit();

    expect(await screen.findByText('两次输入的密码不一致')).toBeInTheDocument();
    expect(mock.calls).toHaveLength(0);
  });

  it('注册成功后调用用户名/密码登录并跳转 /admin/activities', async () => {
    const mock = stubApi({
      'POST /api/cc/auth/admin-register': {
        body: { record: { id: 'a1', username: 'adminuser', collectionName: 'admin_accounts' } },
      },
      'POST /api/collections/admin_accounts/auth-with-password': {
        body: {
          token: makeTestToken(),
          record: { id: 'a1', username: 'adminuser', collectionName: 'admin_accounts' },
        },
      },
    });
    renderRegister();
    fillValidForm();
    submit();

    expect(await screen.findByText('ADMIN_ACTIVITIES_PAGE')).toBeInTheDocument();
    // 注册成功后以用户名 + 密码登录（邀请码已被服务端消费，不可复用）。
    const loginCall = mock.calls.find((c) => c.url.includes('/auth-with-password'));
    expect(loginCall).toBeTruthy();
    expect(JSON.parse(String(loginCall?.init?.body))).toMatchObject({
      identity: 'adminuser',
      password: 'password123',
    });
  });

  it('后端 EMAIL_TAKEN 错误 message 能显示给用户', async () => {
    stubApi({
      'POST /api/cc/auth/admin-register': {
        status: 400,
        body: { message: '邮箱已被使用', data: { code: 'EMAIL_TAKEN' } },
      },
    });
    renderRegister();
    fillValidForm();
    submit();

    expect(await screen.findByText('邮箱已被使用')).toBeInTheDocument();
  });

  it('后端 INVALID_EMAIL 错误 message 能显示给用户', async () => {
    stubApi({
      'POST /api/cc/auth/admin-register': {
        status: 400,
        body: { message: '邮箱格式不正确', data: { code: 'INVALID_EMAIL' } },
      },
    });
    renderRegister();
    fillValidForm();
    submit();

    expect(await screen.findByText('邮箱格式不正确')).toBeInTheDocument();
  });
});
