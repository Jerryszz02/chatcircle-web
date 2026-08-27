import { fireEvent, render, screen, within } from '@testing-library/react';
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
import type { PostRecord } from '../../../shared/api/types';
import { HomePage } from './HomePage';

/**
 * 首页测试（C 端品牌官网落地页，2026-08 UI 重构）。
 * 覆盖：Hero 与 CTA、站点导航、现有活动区块（最近 2 场 + 查看全部）、
 * 往期活动区块（后台公开推文最近 2 篇 + 查看全部）、
 * Our Impact 首场试点真实数据、右上角角色入口。
 */

/** PocketBase 日期格式（'YYYY-MM-DD HH:mm:ss.sssZ'）。 */
const pbDateTime = (d: Date) => d.toISOString().replace('T', ' ');

/** 未结束活动：7 天后开始，持续 2 小时。 */
function activityItem(overrides: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return {
    id: 'act1',
    title: '八月光影茶话会',
    activity_code: 'CC_SG_202608_01',
    description: '一场关于光影与倾诉的聚会。',
    location: '三楼活动室',
    start_time: pbDateTime(start),
    end_time: pbDateTime(new Date(start.getTime() + 2 * 60 * 60 * 1000)),
    status: 'published',
    capacity_total: 20,
    registration: { open: true, reason: null, remaining_total: 5 },
    ...overrides,
  };
}

/** 已结束活动：14 天前举行；默认仍为 published（机构未手动关闭，同凯德专场场景）。 */
function pastActivityItem(overrides: Record<string, unknown> = {}) {
  const start = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  return activityItem({
    id: 'act0',
    title: '六月试点场',
    start_time: pbDateTime(start),
    end_time: pbDateTime(new Date(start.getTime() + 2 * 60 * 60 * 1000)),
    registration: { open: false, reason: 'ended', remaining_total: 0 },
    ...overrides,
  });
}

function postItem(overrides: Partial<PostRecord> = {}): PostRecord {
  return {
    id: 'post1',
    created: '2026-08-01 00:00:00.000Z',
    updated: '2026-08-01 00:00:00.000Z',
    title: '首场活动回顾',
    summary: '后台上传的活动回顾摘要。',
    cover: '',
    body_md: '# 正文',
    external_url: 'https://example.com/post1',
    is_pinned: false,
    status: 'visible',
    published_at: '2026-08-01 00:00:00.000Z',
    ...overrides,
  };
}

function postsList(items: PostRecord[]) {
  return { page: 1, perPage: 2, totalItems: items.length, totalPages: 1, items };
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <HomePage />
    </MemoryRouter>,
  );
}

function stubActivities(activities: unknown[] = [], posts: PostRecord[] = []) {
  return stubApi({
    'GET /api/cc/public/activities': { body: { activities } },
    'GET /api/collections/posts/records': { body: postsList(posts) },
  });
}

describe('HomePage 首页', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('展示品牌 Hero、CTA 与站点导航（logo / 首页 / 现有活动 / 往期活动 / 关于我们）', () => {
    stubActivities();
    renderHome();
    expect(screen.getByText('青年心理健康公益项目')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /真正听见/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '浏览活动' })).toHaveAttribute('href', '/activities');
    // Hero 首场活动真实照片（2026-08 素材到位后由占位块替换）
    expect(screen.getByRole('img', { name: /首场活动现场/ })).toBeInTheDocument();
    // 站点导航：品牌标为 logo 图形（装饰性 alt=""）+ 文字，可访问名仍为「Chat Circles」
    const brandLink = screen.getByRole('link', { name: 'Chat Circles' });
    expect(brandLink).toHaveAttribute('href', '/');
    expect(brandLink.querySelector('.ccp-site-logo-img')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '首页' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: '现有活动' })).toHaveAttribute('href', '/activities');
    expect(screen.getByRole('link', { name: '往期活动' })).toHaveAttribute(
      'href',
      '/activities/past',
    );
    expect(screen.getByRole('link', { name: '关于我们' })).toHaveAttribute('href', '/about');
  });

  it('现有活动区块渲染公开活动卡片（报名状态 + 报名入口 + 查看全部）', async () => {
    stubActivities([activityItem()]);
    renderHome();
    expect(await screen.findByText('八月光影茶话会')).toBeInTheDocument();
    expect(screen.getByText('报名中')).toBeInTheDocument();
    expect(screen.getByText(/剩余名额：5/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '立即报名' })).toHaveAttribute(
      'href',
      '/a/act1/register',
    );
    const upcoming = screen.getByRole('region', { name: '现有活动' });
    expect(within(upcoming).queryByText('活动照片')).not.toBeInTheDocument();
    expect(within(upcoming).getByRole('link', { name: '查看全部 →' })).toHaveAttribute(
      'href',
      '/activities',
    );
  });

  it('已结束活动不在首页展示，往期活动区只展示后台公开推文', async () => {
    stubActivities(
      [
        pastActivityItem({ id: 'act-closed', title: '六月试点场', status: 'closed' }),
        pastActivityItem({ id: 'act-kaide', title: 'Chat Circles · 凯德专场' }),
      ],
      [postItem({ title: '后台活动回顾' })],
    );
    renderHome();
    const upcoming = screen.getByRole('region', { name: '现有活动' });
    expect(await within(upcoming).findByText(/新活动筹备中/)).toBeInTheDocument();
    expect(within(upcoming).queryByText('六月试点场')).not.toBeInTheDocument();
    expect(within(upcoming).queryByText('Chat Circles · 凯德专场')).not.toBeInTheDocument();
    const past = screen.getByRole('region', { name: '往期活动' });
    expect(await within(past).findByText('后台活动回顾')).toBeInTheDocument();
    expect(within(past).queryByText('六月试点场')).not.toBeInTheDocument();
    expect(within(past).queryByText('Chat Circles · 凯德专场')).not.toBeInTheDocument();
    expect(within(past).getByRole('link', { name: '查看全部 →' })).toHaveAttribute(
      'href',
      '/activities/past',
    );
  });

  it('现有活动与后台推文各最多展示 2 条，完整列表进独立页', async () => {
    const mock = stubActivities(
      [
        activityItem({ id: 'c1', title: '现有场次一' }),
        activityItem({ id: 'c2', title: '现有场次二' }),
        activityItem({ id: 'c3', title: '现有场次三' }),
      ],
      [
        postItem({ id: 'post1', title: '后台推文一' }),
        postItem({ id: 'post2', title: '后台推文二' }),
        postItem({ id: 'post3', title: '后台推文三' }),
      ],
    );
    renderHome();
    const upcoming = screen.getByRole('region', { name: '现有活动' });
    expect(await within(upcoming).findByText('现有场次一')).toBeInTheDocument();
    expect(within(upcoming).getByText('现有场次二')).toBeInTheDocument();
    expect(within(upcoming).queryByText('现有场次三')).not.toBeInTheDocument();
    const past = screen.getByRole('region', { name: '往期活动' });
    expect(await within(past).findByText('后台推文一')).toBeInTheDocument();
    expect(within(past).getByText('后台推文二')).toBeInTheDocument();
    expect(within(past).queryByText('后台推文三')).not.toBeInTheDocument();
    expect(within(past).getAllByRole('listitem')).toHaveLength(2);
    const postCall = mock.calls.find((call) => call.url.includes('/api/collections/posts/records'));
    expect(decodeURIComponent(postCall?.url ?? '')).toContain('perPage=2');
    expect(
      mock.calls.some((call) => call.url.includes('/api/cc/public/activities?scope=current')),
    ).toBe(true);
    expect(mock.calls.some((call) => call.url.includes('scope=past'))).toBe(false);
  });

  it('活动加载失败后重试成功：错误提示与重试按钮被清除', async () => {
    stubApi({
      'GET /api/cc/public/activities': { status: 500, body: { message: '服务器错误', data: {} } },
      'GET /api/collections/posts/records': { body: postsList([]) },
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

  it('往期活动区块展示后台公开推文的封面、摘要与原文链接', async () => {
    stubActivities([], [postItem({ cover: 'cover.png' })]);
    renderHome();
    expect(screen.getByRole('heading', { name: '往期活动' })).toBeInTheDocument();
    expect(await screen.findByText('首场活动回顾')).toBeInTheDocument();
    expect(screen.getByText('后台上传的活动回顾摘要。')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '首场活动回顾封面' })).toHaveAttribute(
      'src',
      expect.stringContaining('/api/files/posts/post1/cover.png'),
    );
    expect(screen.getByRole('link', { name: '阅读原文' })).toHaveAttribute(
      'href',
      'https://example.com/post1',
    );
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
