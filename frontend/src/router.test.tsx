import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppRoutes } from './router';
import { pbClients, type Role } from './shared/pocketbase';
import { stubApi, unstubApi } from './test/mockApi';

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
  // 活动与问卷页会拉取公开活动列表，统一兜底为空列表，避免真实网络请求。
  stubApi({ 'GET /api/cc/public/activities': { body: { activities: [] } } });
});

afterEach(() => {
  unstubApi();
});

describe('路由分区（公开页）', () => {
  it('/ 渲染首页（项目介绍落地页，未登录可看）', () => {
    renderAt('/');
    expect(screen.getByText('参与者端')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Chat Circles' })).toBeInTheDocument();
  });

  it('/activities 渲染活动与问卷页（活动广场，未登录可看）', () => {
    renderAt('/activities');
    expect(screen.getByRole('heading', { name: '活动' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '问卷' })).toBeInTheDocument();
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
  it('未登录访问 /checkin/:token：跳 /login（redirect 回跳地址由守卫单测覆盖）', () => {
    renderAt('/checkin/tok123');
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

  it('参与者会话可访问 /checkin/:token', () => {
    saveSession('participant');
    renderAt('/checkin/tok123');
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

  it('单会话互斥：参与者会话访问 /admin/login、/super/login：回首页', () => {
    saveSession('participant');
    renderAt('/admin/login');
    expect(screen.queryByRole('heading', { name: '管理员登录' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Chat Circles' })).toBeInTheDocument();
  });

  it('单会话互斥：机构管理员会话访问 /login、/super/login：回首页或本端面板', () => {
    saveSession('admin');
    renderAt('/super/login');
    expect(screen.queryByRole('heading', { name: '超级管理员登录' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Chat Circles' })).toBeInTheDocument();
  });
});
