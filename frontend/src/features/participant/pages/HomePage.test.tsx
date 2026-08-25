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
 * 首页测试（C 端品牌官网落地页，2026-08 UI 重构）。
 * 覆盖：Hero 与 CTA、站点导航、现有活动区块（公开活动 API 真实数据）、
 * 往期活动（活动故事并入同一区块）静态占位、Our Impact 首场试点真实数据、右上角角色入口。
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

function stubActivities(activities: unknown[] = []) {
  return stubApi({ 'GET /api/cc/public/activities': { body: { activities } } });
}

describe('HomePage 首页', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('展示品牌 Hero、CTA 与站点导航（logo / 现有活动 / 往期活动 / 关于我们）', () => {
    stubActivities();
    renderHome();
    expect(screen.getByText('青年心理健康公益项目')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /真正听见/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '浏览活动' })).toHaveAttribute('href', '/activities');
    // 站点导航
    expect(screen.getByRole('link', { name: 'Chat Circles' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: '现有活动' })).toHaveAttribute('href', '/activities');
    expect(screen.getByRole('link', { name: '往期活动' })).toHaveAttribute('href', '/#past');
    expect(screen.getByRole('link', { name: '关于我们' })).toHaveAttribute('href', '/about');
  });

  it('现有活动区块渲染公开活动卡片（报名状态 + 报名入口）', async () => {
    stubActivities([activityItem()]);
    renderHome();
    expect(await screen.findByText('八月光影茶话会')).toBeInTheDocument();
    expect(screen.getByText('报名中')).toBeInTheDocument();
    expect(screen.getByText(/剩余名额：5/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '立即报名' })).toHaveAttribute(
      'href',
      '/a/act1/register',
    );
    expect(screen.getByRole('link', { name: '全部活动 →' })).toHaveAttribute(
      'href',
      '/activities',
    );
  });

  it('已结束（closed）活动不在首页现有活动区展示；无活动时显示空态文案', async () => {
    stubActivities([activityItem({ id: 'act0', title: '六月试点场', status: 'closed' })]);
    renderHome();
    expect(await screen.findByText(/新活动筹备中/)).toBeInTheDocument();
    expect(screen.queryByText('六月试点场')).not.toBeInTheDocument();
  });

  it('活动加载失败后重试成功：错误提示与重试按钮被清除', async () => {
    stubApi({
      'GET /api/cc/public/activities': { status: 500, body: { message: '服务器错误', data: {} } },
    });
    renderHome();
    expect(await screen.findByText('服务器错误')).toBeInTheDocument();
    // 重试时换成成功响应
    stubActivities([activityItem()]);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('八月光影茶话会')).toBeInTheDocument();
    expect(screen.queryByText('服务器错误')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  });

  it('往期活动区块合并展示活动故事（同一区块，无独立「活动故事」标题）', () => {
    stubActivities();
    renderHome();
    expect(screen.getByRole('heading', { name: '往期活动' })).toBeInTheDocument();
    expect(screen.getByText(/首场对话活动/)).toBeInTheDocument();
    expect(screen.getByText(/首场活动回顾/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '活动故事' })).not.toBeInTheDocument();
  });

  it('Our Impact 展示首场试点真实数据与参与者引言，并标注样本口径', () => {
    stubActivities();
    renderHome();
    expect(screen.getByRole('heading', { name: '我们的影响' })).toBeInTheDocument();
    expect(screen.getByText('77%')).toBeInTheDocument();
    expect(screen.getByText('−2.15')).toBeInTheDocument();
    expect(screen.getByText('60')).toBeInTheDocument();
    expect(screen.getByText('73%')).toBeInTheDocument();
    expect(screen.getByText(/一个暂停下来、梳理自己的机会/)).toBeInTheDocument();
    expect(screen.getByText(/小样本自报数据/)).toBeInTheDocument();
  });

  it('未登录：右上角「登录」菜单聚合三类登录入口', () => {
    stubActivities();
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
    stubActivities();
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
    stubActivities();
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
    stubActivities();
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
