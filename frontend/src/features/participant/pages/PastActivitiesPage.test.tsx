import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllSessions, stubApi, unstubApi } from '../../../test/mockApi';
import { PastActivitiesPage } from './PastActivitiesPage';

/**
 * 往期活动页测试（/activities/past，未登录可看）：
 * 只展示已结束/已关闭场次（closed 或 end_time 已过，判定口径见 lib/activitySplit.ts），
 * 未结束的现有活动不出现；覆盖空态与加载失败分支。
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/activities/past']}>
      <PastActivitiesPage />
    </MemoryRouter>,
  );
}

describe('PastActivitiesPage 往期活动页', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('展示已结束/已关闭活动：closed 与 end_time 已过（未手动关闭）都算往期', async () => {
    const mock = stubApi({
      'GET /api/cc/public/activities': {
        body: {
          activities: [
            activityItem({ id: 'c1', title: '八月光影茶话会' }),
            // 凯德专场回归：end_time 已过但机构未手动关闭（status 仍是 published）
            pastActivityItem({ id: 'p1', title: 'Chat Circles · 凯德专场（2026-06-12）' }),
            pastActivityItem({ id: 'p2', title: '六月试点场', status: 'closed' }),
          ],
        },
      },
    });
    renderPage();
    // 往期页经 ?scope=past 服务端过滤（完整往期列表不被 100 条上限截断）
    expect(mock.calls.some((c) => c.url.includes('/api/cc/public/activities?scope=past'))).toBe(
      true,
    );
    expect(await screen.findByText(/凯德专场/)).toBeInTheDocument();
    expect(screen.getByText('六月试点场')).toBeInTheDocument();
    // closed 场次展示「已关闭」标签，卡片只提供「查看详情」不提供报名入口
    expect(screen.getByText('已关闭')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '立即报名' })).not.toBeInTheDocument();
    // 未结束的现有活动不出现在往期页
    expect(screen.queryByText('八月光影茶话会')).not.toBeInTheDocument();
  });

  it('往期活动全部展示（不做首页的 2 场截断）', async () => {
    stubApi({
      'GET /api/cc/public/activities': {
        body: {
          activities: [
            pastActivityItem({ id: 'p1', title: '往期场次一' }),
            pastActivityItem({ id: 'p2', title: '往期场次二' }),
            pastActivityItem({ id: 'p3', title: '往期场次三' }),
          ],
        },
      },
    });
    renderPage();
    expect(await screen.findByText('往期场次一')).toBeInTheDocument();
    expect(screen.getByText('往期场次二')).toBeInTheDocument();
    expect(screen.getByText('往期场次三')).toBeInTheDocument();
  });

  it('无往期活动时展示空态文案', async () => {
    stubApi({
      'GET /api/cc/public/activities': { body: { activities: [activityItem()] } },
    });
    renderPage();
    expect(await screen.findByText('暂无往期活动。')).toBeInTheDocument();
    expect(screen.queryByText('八月光影茶话会')).not.toBeInTheDocument();
  });

  it('加载失败展示错误提示与重试入口', async () => {
    stubApi({
      'GET /api/cc/public/activities': { status: 500, body: { message: '服务器错误', data: {} } },
    });
    renderPage();
    expect(await screen.findByText('服务器错误')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });
});
