import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppRoutes } from './router';
import { pbClients, type Role } from './shared/pocketbase';

function makeToken(): string {
  const b64 = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    exp: Math.floor(Date.now() / 1000) + 3600,
    id: 'x',
    type: 'authRecord',
    collectionId: 'c',
  })}.sig`;
}

function saveSession(role: Role) {
  const collectionName = {
    participant: 'participant_accounts',
    admin: 'admin_accounts',
    super: '_superusers',
  }[role];
  pbClients[role].authStore.save(makeToken(), { id: `${role}_id`, collectionName } as never);
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.values(pbClients).forEach((c) => c.authStore.clear());
});

describe('路由分区（公开页）', () => {
  it('/ 渲染参与者端占位页', () => {
    renderAt('/');
    expect(screen.getByText('参与者端')).toBeInTheDocument();
    expect(screen.getByText('开发中')).toBeInTheDocument();
  });

  it('/a/:activityId 公开活动详情未登录可看（FR-ACT-003）', () => {
    renderAt('/a/act123');
    expect(screen.getByRole('heading', { name: '公开活动详情' })).toBeInTheDocument();
  });

  it('/login 通用登录页未登录可看', () => {
    renderAt('/login');
    expect(screen.getByRole('heading', { name: '平台通用登录' })).toBeInTheDocument();
  });
});

describe('路由守卫（technical-design §5.3）', () => {
  it('未登录访问 /checkin/:activityId：跳 /login（redirect 回跳地址由守卫单测覆盖）', () => {
    renderAt('/checkin/act123');
    expect(screen.queryByRole('heading', { name: '扫码签到' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '平台通用登录' })).toBeInTheDocument();
  });

  it('未登录访问 /me：跳 /login', () => {
    renderAt('/me');
    expect(screen.getByRole('heading', { name: '平台通用登录' })).toBeInTheDocument();
  });

  it('未登录访问 /admin/activities：跳 /admin/login', () => {
    renderAt('/admin/activities');
    expect(screen.getByRole('heading', { name: '管理员登录' })).toBeInTheDocument();
  });

  it('未登录访问 /super/dashboard：跳 /super/login', () => {
    renderAt('/super/dashboard');
    expect(screen.getByRole('heading', { name: '超级管理员登录' })).toBeInTheDocument();
  });

  it('参与者会话可访问 /checkin/:activityId', () => {
    saveSession('participant');
    renderAt('/checkin/act123');
    expect(screen.getByRole('heading', { name: '扫码签到' })).toBeInTheDocument();
  });

  it('机构管理员会话可访问 /admin/activities', () => {
    saveSession('admin');
    renderAt('/admin/activities');
    expect(screen.getByRole('heading', { name: '活动列表' })).toBeInTheDocument();
  });

  it('超级管理员会话可访问 /super/dashboard', () => {
    saveSession('super');
    renderAt('/super/dashboard');
    expect(screen.getByRole('heading', { name: '全局看板' })).toBeInTheDocument();
  });

  it('参与者会话访问 /admin/activities：渲染 403 占位页', () => {
    saveSession('participant');
    renderAt('/admin/activities');
    expect(screen.getByText('403 无权访问')).toBeInTheDocument();
  });
});
