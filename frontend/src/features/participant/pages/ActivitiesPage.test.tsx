import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllSessions,
  saveParticipantSession,
  stubApi,
  unstubApi,
} from '../../../test/mockApi';
import { ActivitiesPage } from './ActivitiesPage';

/**
 * 活动与问卷页测试（/activities，由首页拆出）：
 * 覆盖活动列表渲染与报名状态分支、空列表、未登录问卷指引、
 * 已登录时展示「我的」开放问卷（含草稿续填）。
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

function renderPage(initialEntry = '/activities') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ActivitiesPage />
    </MemoryRouter>,
  );
}

describe('ActivitiesPage 活动与问卷页', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('未登录可看：展示活动列表与报名入口，无需账号', async () => {
    stubApi({
      'GET /api/cc/public/activities': { body: { activities: [activityItem()] } },
    });
    renderPage();
    expect(await screen.findByText('八月光影茶话会')).toBeInTheDocument();
    expect(screen.getByText('报名中')).toBeInTheDocument();
    expect(screen.getByText(/剩余名额：5/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '立即报名' })).toHaveAttribute(
      'href',
      '/a/act1/register',
    );
    // 顶部「登录」菜单（未登录时聚合三类登录入口）
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
    // 站点导航 logo 回首页
    expect(screen.getByRole('link', { name: 'Chat Circles' })).toHaveAttribute('href', '/');
  });

  it('报名未开放的活动展示原因标签与「查看详情」', async () => {
    stubApi({
      'GET /api/cc/public/activities': {
        body: {
          activities: [activityItem({ registration: { open: false, reason: 'full' } })],
        },
      },
    });
    renderPage();
    expect(await screen.findByText('名额已满')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '立即报名' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看详情' })).toHaveAttribute('href', '/a/act1');
  });

  it('暂无公开活动时展示空态文案', async () => {
    stubApi({ 'GET /api/cc/public/activities': { body: { activities: [] } } });
    renderPage();
    expect(await screen.findByText(/暂无进行中的活动/)).toBeInTheDocument();
  });

  it('未登录时问卷区引导扫码/登录，不请求「我的」总览', async () => {
    const mock = stubApi({
      'GET /api/cc/public/activities': { body: { activities: [] } },
    });
    renderPage();
    expect(await screen.findByText(/问卷通过活动现场的二维码进入/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '登录查看我的问卷' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(mock.calls.some((c) => c.url.includes('/api/cc/me/overview'))).toBe(false);
  });

  it('已登录但无开放问卷：展示空态提示', async () => {
    saveParticipantSession();
    stubApi({
      'GET /api/cc/public/activities': { body: { activities: [] } },
      'GET /api/cc/me/overview': {
        body: { registrations: [], submissions: [], open_surveys: [] },
      },
    });
    renderPage();
    expect(await screen.findByText(/当前没有可填写的问卷/)).toBeInTheDocument();
  });

  it('已登录：展示开放中的问卷与填写入口', async () => {
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
            {
              survey: {
                id: 's2',
                title: '续填问卷',
                role_scope: 'all',
                status: 'open',
                qr_token: 'qr_token_2',
              },
              activity_title: '八月光影茶话会',
              my_submission: { id: 'sub1', status: 'draft' },
            },
          ],
        },
      },
    });
    renderPage();
    expect(await screen.findByText('活动反馈问卷')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '去填写' })).toHaveAttribute(
      'href',
      '/survey/qr_token_1',
    );
    // 草稿问卷展示「草稿待继续」标签与「继续填写」入口
    expect(screen.getByText('草稿待继续')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '继续填写' })).toHaveAttribute(
      'href',
      '/survey/qr_token_2',
    );
  });
});
