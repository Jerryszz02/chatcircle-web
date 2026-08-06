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
 * 首页测试：未登录可看的活动广场 + 登录/问卷入口。
 * 覆盖：活动列表渲染与报名状态分支、空列表、未登录问卷指引、
 * 已登录时展示「我的」开放问卷。
 */

function activityItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'act1',
    title: '八月光影茶话会',
    activity_code: 'CC_SG_202608_01',
    description: '一场关于光影与倾诉的聚会。',
    location: '三楼活动室',
    start_time: '2026-08-10 02:00:00.000Z',
    end_time: '2026-08-10 04:00:00.000Z',
    status: 'published',
    capacity_total: 20,
    registration: { open: true, reason: null, remaining_total: 5 },
    ...overrides,
  };
}

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

  it('未登录可看：展示活动列表与报名入口，无需账号', async () => {
    stubApi({
      'GET /api/cc/public/activities': { body: { activities: [activityItem()] } },
    });
    renderHome();
    expect(await screen.findByText('八月光影茶话会')).toBeInTheDocument();
    expect(screen.getByText('报名中')).toBeInTheDocument();
    expect(screen.getByText(/剩余名额：5/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '立即报名' })).toHaveAttribute(
      'href',
      '/a/act1/register',
    );
    // 顶部与问卷区均有登录入口
    expect(screen.getAllByRole('link', { name: /登录/ }).length).toBeGreaterThan(0);
    // 右上角「登录」菜单聚合三类登录入口（参与者/机构管理员/超管）
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

  it('报名未开放的活动展示原因标签与「查看详情」', async () => {
    stubApi({
      'GET /api/cc/public/activities': {
        body: {
          activities: [activityItem({ registration: { open: false, reason: 'full' } })],
        },
      },
    });
    renderHome();
    expect(await screen.findByText('名额已满')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '立即报名' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看详情' })).toHaveAttribute('href', '/a/act1');
  });

  it('暂无公开活动时展示空态文案', async () => {
    stubApi({ 'GET /api/cc/public/activities': { body: { activities: [] } } });
    renderHome();
    expect(await screen.findByText(/暂无进行中的活动/)).toBeInTheDocument();
  });

  it('展示项目介绍区块与页内锚点导航', async () => {
    stubApi({ 'GET /api/cc/public/activities': { body: { activities: [] } } });
    renderHome();
    // 吸顶导航：介绍区块 + 活动/问卷锚点
    expect(screen.getByRole('link', { name: '挑战' })).toHaveAttribute('href', '#challenge');
    expect(screen.getByRole('link', { name: '计划' })).toHaveAttribute('href', '#programme');
    expect(screen.getByRole('link', { name: '影响' })).toHaveAttribute('href', '#impact');
    expect(screen.getByRole('link', { name: '成效评估' })).toHaveAttribute('href', '#measurement');
    expect(screen.getByRole('link', { name: '合作伙伴' })).toHaveAttribute('href', '#partners');
    expect(screen.getByRole('link', { name: '活动' })).toHaveAttribute('href', '#activities');
    expect(screen.getByRole('link', { name: '问卷' })).toHaveAttribute('href', '#surveys');
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

  it('未登录时问卷区引导扫码/登录，不请求「我的」总览', async () => {
    const mock = stubApi({
      'GET /api/cc/public/activities': { body: { activities: [] } },
    });
    renderHome();
    expect(await screen.findByText(/问卷通过活动现场的二维码进入/)).toBeInTheDocument();
    expect(mock.calls.some((c) => c.url.includes('/api/cc/me/overview'))).toBe(false);
  });

  it('参与者已登录且无管理端会话：隐藏管理登录入口', async () => {
    saveParticipantSession();
    stubApi({
      'GET /api/cc/public/activities': { body: { activities: [] } },
      'GET /api/cc/me/overview': {
        body: { registrations: [], submissions: [], open_surveys: [] },
      },
    });
    renderHome();
    expect(await screen.findByText(/当前没有可填写的问卷/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '机构管理员登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '超级管理员登录' })).not.toBeInTheDocument();
    expect(screen.queryByText('管理入口')).not.toBeInTheDocument();
  });

  it('管理端已登录：顶部入口指向机构管理面板，不出现登录入口', async () => {
    pbClients.admin.authStore.save(makeTestToken(), {
      id: 'a1',
      username: 'admin1',
      collectionName: 'admin_accounts',
    } as never);
    stubApi({
      'GET /api/cc/public/activities': { body: { activities: [] } },
    });
    renderHome();
    // 顶部入口指向当前角色的面板，不再出现参与者「登录」菜单
    expect(await screen.findByRole('link', { name: '机构管理面板' })).toHaveAttribute(
      'href',
      '/admin/activities',
    );
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '机构管理员登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '超级管理员登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '登录查看我的问卷' })).not.toBeInTheDocument();
  });

  it('超管已登录：顶部入口指向超级管理面板，不出现登录入口', async () => {
    pbClients.super.authStore.save(makeTestToken(), {
      id: 's1',
      email: 'super@example.com',
      collectionName: '_superusers',
    } as never);
    stubApi({
      'GET /api/cc/public/activities': { body: { activities: [] } },
    });
    renderHome();
    expect(await screen.findByRole('link', { name: '超级管理面板' })).toHaveAttribute(
      'href',
      '/super/dashboard',
    );
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '机构管理员登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '超级管理员登录' })).not.toBeInTheDocument();
  });

  it('已登录：展示「我的中心」入口与开放中的问卷', async () => {
    saveParticipantSession();
    stubApi({
      'GET /api/cc/public/activities': { body: { activities: [] } },
      'GET /api/cc/me/overview': {
        body: {
          registrations: [],
          submissions: [],
          open_surveys: [
            {
              survey: {
                id: 's1',
                title: '活动反馈问卷',
                role_scope: 'all',
                status: 'open',
                qr_token: 'qr_token_1',
              },
              activity_title: '八月光影茶话会',
              my_submission: null,
            },
          ],
        },
      },
    });
    renderHome();
    expect(await screen.findByText('活动反馈问卷')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '我的中心' })).toHaveAttribute('href', '/me');
    expect(screen.getByRole('link', { name: '去填写' })).toHaveAttribute(
      'href',
      '/survey/qr_token_1',
    );
  });
});
