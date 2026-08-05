import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from './router';

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe('路由分区', () => {
  it('/ 渲染参与者端占位页', () => {
    renderAt('/');
    expect(screen.getByText('参与者端')).toBeInTheDocument();
    expect(screen.getByText('开发中')).toBeInTheDocument();
  });

  it('/checkin/:activityId 渲染签到页', () => {
    renderAt('/checkin/act123');
    expect(screen.getByText('参与者端')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '扫码签到' })).toBeInTheDocument();
  });

  it('/admin/activities 渲染机构管理端占位页', () => {
    renderAt('/admin/activities');
    expect(screen.getByText('机构管理端')).toBeInTheDocument();
  });

  it('/super/dashboard 渲染超级管理端占位页', () => {
    renderAt('/super/dashboard');
    expect(screen.getByText('超级管理端')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '全局看板' })).toBeInTheDocument();
  });
});
