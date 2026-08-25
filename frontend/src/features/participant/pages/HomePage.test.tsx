import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllSessions,
  makeTestToken,
  saveParticipantSession,
  stubApi,
  unstubApi,
} from '../../../test/mockApi';
import { pbClients } from '../../../shared/pocketbase';
import { HomePage } from './HomePage';

/**
 * 首页测试：项目介绍落地页（活动广场与问卷入口已拆到 /activities，见 ActivitiesPage.test.tsx）。
 * 覆盖：hero 与 CTA、页内锚点导航、项目介绍区块、右上角角色入口。
 */

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <HomePage />
    </MemoryRouter>,
  );
}

describe('HomePage 首页', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('展示平台介绍 hero 与「浏览活动与问卷」入口，不再请求公开活动列表', () => {
    const mock = stubApi({});
    renderHome();
    expect(screen.getByText('参与者端')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Chat Circles' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '浏览活动与问卷' })).toHaveAttribute(
      'href',
      '/activities',
    );
    expect(mock.calls.some((c) => c.url.includes('/api/cc/public/activities'))).toBe(false);
  });

  it('展示项目介绍区块与导航：介绍区块为页内锚点', () => {
    stubApi({});
    renderHome();
    // 吸顶导航：介绍区块锚点
    expect(screen.getByRole('link', { name: '挑战' })).toHaveAttribute('href', '#challenge');
    expect(screen.getByRole('link', { name: '计划' })).toHaveAttribute('href', '#programme');
    expect(screen.getByRole('link', { name: '影响' })).toHaveAttribute('href', '#impact');
    expect(screen.getByRole('link', { name: '成效评估' })).toHaveAttribute('href', '#measurement');
    expect(screen.getByRole('link', { name: '合作伙伴' })).toHaveAttribute('href', '#partners');
    expect(screen.queryByRole('link', { name: '活动' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '问卷' })).not.toBeInTheDocument();
    // 介绍区块标题（内容移植自计划书）
    expect(
      screen.getByRole('heading', { name: '正处于过渡期的青年，比任何时候都更感压力与孤独' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '一套完整的计划——而非单次活动' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Chat Circles 为所有参与者创造的价值' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '我们如何衡量重要的事' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '为社区影响力而生的合作' })).toBeInTheDocument();
  });

  it('未登录：右上角「登录」菜单聚合三类登录入口', () => {
    stubApi({});
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(screen.getByRole('menuitem', { name: '参与者登录' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('menuitem', { name: '机构管理员登录' })).toHaveAttribute(
      'href',
      '/admin/login',
    );
    expect(screen.getByRole('menuitem', { name: '超级管理员登录' })).toHaveAttribute(
      'href',
      '/super/login',
    );
  });

  it('参与者已登录：顶部入口指向「我的中心」，不出现登录菜单', () => {
    saveParticipantSession();
    stubApi({});
    renderHome();
    expect(screen.getByRole('link', { name: '我的中心' })).toHaveAttribute('href', '/me');
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument();
  });

  it('管理端已登录：顶部入口指向机构管理面板，不出现登录入口', () => {
    pbClients.admin.authStore.save(makeTestToken(), {
      id: 'a1',
      username: 'admin1',
      collectionName: 'admin_accounts',
    } as never);
    stubApi({});
    renderHome();
    expect(screen.getByRole('link', { name: '机构管理面板' })).toHaveAttribute(
      'href',
      '/admin/activities',
    );
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '机构管理员登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '超级管理员登录' })).not.toBeInTheDocument();
  });

  it('超管已登录：顶部入口指向超级管理面板，不出现登录入口', () => {
    pbClients.super.authStore.save(makeTestToken(), {
      id: 's1',
      email: 'super@example.com',
      collectionName: '_superusers',
    } as never);
    stubApi({});
    renderHome();
    expect(screen.getByRole('link', { name: '超级管理面板' })).toHaveAttribute(
      'href',
      '/super/dashboard',
    );
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '机构管理员登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '超级管理员登录' })).not.toBeInTheDocument();
  });
});
