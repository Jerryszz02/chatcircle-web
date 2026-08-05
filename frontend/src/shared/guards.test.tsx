import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { RequireRole } from './guards';
import { pbClients, type Role } from './pocketbase';

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

/** 登录页替身：显示当前路径与 query，用于断言重定向目标。 */
function LoginStub() {
  const location = useLocation();
  return <div>{`登录页 ${location.pathname}${location.search}`}</div>;
}

function renderGuarded(path: string, role: Role) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginStub />} />
        <Route path="/admin/login" element={<LoginStub />} />
        <Route path="/super/login" element={<LoginStub />} />
        <Route
          path="/protected/*"
          element={
            <RequireRole role={role}>
              <div>受保护内容</div>
            </RequireRole>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.values(pbClients).forEach((c) => c.authStore.clear());
});

describe('RequireRole 路由守卫（technical-design §5.3）', () => {
  it('未登录访问参与者页：跳 /login 并记录 redirect 回跳地址', () => {
    renderGuarded('/protected/me?tab=survey', 'participant');
    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument();
    expect(
      screen.getByText(`登录页 /login?redirect=${encodeURIComponent('/protected/me?tab=survey')}`),
    ).toBeInTheDocument();
  });

  it('未登录访问机构管理页：跳 /admin/login', () => {
    renderGuarded('/protected/dashboard', 'admin');
    expect(screen.getByText('登录页 /admin/login')).toBeInTheDocument();
  });

  it('未登录访问超级管理页：跳 /super/login', () => {
    renderGuarded('/protected/dashboard', 'super');
    expect(screen.getByText('登录页 /super/login')).toBeInTheDocument();
  });

  it('角色会话匹配：渲染受保护内容', () => {
    saveSession('admin');
    renderGuarded('/protected/dashboard', 'admin');
    expect(screen.getByText('受保护内容')).toBeInTheDocument();
  });

  it('已登录但角色不符：渲染 403 占位页', () => {
    saveSession('participant');
    renderGuarded('/protected/dashboard', 'admin');
    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument();
    expect(screen.getByText('403 无权访问')).toBeInTheDocument();
  });

  it('超管会话访问参与者受保护页：同样按角色不符渲染 403', () => {
    saveSession('super');
    renderGuarded('/protected/me', 'participant');
    expect(screen.getByText('403 无权访问')).toBeInTheDocument();
  });
});
