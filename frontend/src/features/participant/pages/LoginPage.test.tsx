import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllSessions,
  makeTestToken,
  saveParticipantSession,
  stubApi,
  unstubApi,
} from '../../../test/mockApi';
import { LoginPage } from './LoginPage';
import { pbClients } from '../../../shared/pocketbase';

/**
 * 通用登录页测试（FR-AUTH-008、FR-PAR-004、AC-22 前端侧）。
 * 覆盖：手机号主入口、存量账号迁移、登录后进入「我的」中心、redirect 回跳、
 * 已登录访问直达目标页。
 */

function renderLogin(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/me" element={<div>ME_PAGE</div>} />
        <Route path="/a/:activityId" element={<div>ACTIVITY_PAGE</div>} />
        <Route path="/" element={<div>HOME_PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LoginPage 平台通用登录', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('默认提供手机号登录/注册，并保留原账号迁移入口', () => {
    stubApi({});
    renderLogin('/login');
    expect(screen.getByRole('heading', { name: '平台通用登录' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^手机号/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '使用原用户名账号迁移' })).toBeInTheDocument();
    // 顶部提供返回首页入口
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveAttribute('href', '/');
  });

  it('登录成功：无 redirect 时进入「我的」中心', async () => {
    stubApi({
      'POST /api/cc/auth/participant': {
        body: {
          token: makeTestToken(),
          record: { id: 'p1', username: 'test_user', collectionName: 'participant_accounts', phone_migration_status: 'phone_bound' },
        },
      },
    });
    renderLogin('/login');
    fireEvent.click(screen.getByRole('button', { name: '使用原用户名账号迁移' }));
    fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: 'test_user' } });
    fireEvent.change(screen.getByLabelText(/密码/), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录原账号' }));
    expect(await screen.findByText('ME_PAGE')).toBeInTheDocument();
  });

  it('登录成功：redirect 回跳原目标页（AC-22）', async () => {
    stubApi({
      'POST /api/cc/auth/participant': {
        body: {
          token: makeTestToken(),
          record: { id: 'p1', username: 'test_user', collectionName: 'participant_accounts', phone_migration_status: 'phone_bound' },
        },
      },
    });
    renderLogin(`/login?redirect=${encodeURIComponent('/a/act1')}`);
    fireEvent.click(screen.getByRole('button', { name: '使用原用户名账号迁移' }));
    fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: 'test_user' } });
    fireEvent.change(screen.getByLabelText(/密码/), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录原账号' }));
    expect(await screen.findByText('ACTIVITY_PAGE')).toBeInTheDocument();
  });

  it('已登录访问 /login：直达目标页', async () => {
    stubApi({});
    saveParticipantSession();
    renderLogin('/login');
    expect(await screen.findByText('ME_PAGE')).toBeInTheDocument();
  });

  it('已登录其它身份（机构管理员）：不提供第二个登录，回首页', async () => {
    stubApi({});
    pbClients.admin.authStore.save(makeTestToken(), {
      id: 'a1',
      username: 'admin1',
      collectionName: 'admin_accounts',
    } as never);
    renderLogin('/login');
    expect(await screen.findByText('HOME_PAGE')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /^手机号/ })).not.toBeInTheDocument();
  });

  it('redirect 为站外地址：忽略并落到「我的」中心（防开放重定向）', async () => {
    stubApi({});
    saveParticipantSession();
    renderLogin(`/login?redirect=${encodeURIComponent('https://evil.example.com')}`);
    expect(await screen.findByText('ME_PAGE')).toBeInTheDocument();
  });
});
