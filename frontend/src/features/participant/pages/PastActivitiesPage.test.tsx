import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PostRecord } from '../../../shared/api/types';
import { clearAllSessions, stubApi, unstubApi } from '../../../test/mockApi';
import { PastActivitiesPage } from './PastActivitiesPage';

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

function listBody(items: PostRecord[]) {
  return { page: 1, perPage: 500, totalItems: items.length, totalPages: 1, items };
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

  it('只读取后台公开推文，并按置顶、发布时间约定排序', async () => {
    const mock = stubApi({
      'GET /api/collections/posts/records': {
        body: listBody([
          postItem({ id: 'post1', title: '置顶回顾', is_pinned: true }),
          postItem({ id: 'post2', title: '普通回顾' }),
        ]),
      },
    });
    renderPage();
    expect(await screen.findByText('置顶回顾')).toBeInTheDocument();
    expect(screen.getByText('普通回顾')).toBeInTheDocument();
    const listCall = mock.calls.find((call) => call.url.includes('/api/collections/posts/records'));
    expect(decodeURIComponent(listCall?.url ?? '')).toContain('sort=-is_pinned,-published_at');
    expect(mock.calls.some((call) => call.url.includes('/api/cc/public/activities'))).toBe(false);
  });

  it('完整页展示全部后台推文，不做首页的 2 篇截断', async () => {
    stubApi({
      'GET /api/collections/posts/records': {
        body: listBody([
          postItem({ id: 'post1', title: '后台推文一' }),
          postItem({ id: 'post2', title: '后台推文二' }),
          postItem({ id: 'post3', title: '后台推文三' }),
        ]),
      },
    });
    renderPage();
    expect(await screen.findByText('后台推文一')).toBeInTheDocument();
    expect(screen.getByText('后台推文二')).toBeInTheDocument();
    expect(screen.getByText('后台推文三')).toBeInTheDocument();
  });

  it('无公开推文时展示空态文案', async () => {
    stubApi({ 'GET /api/collections/posts/records': { body: listBody([]) } });
    renderPage();
    expect(await screen.findByText('暂无往期活动。')).toBeInTheDocument();
  });

  it('加载失败展示错误提示与重试入口', async () => {
    stubApi({
      'GET /api/collections/posts/records': {
        status: 500,
        body: { message: '服务器错误', data: {} },
      },
    });
    renderPage();
    expect(await screen.findByText('服务器错误')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });
});
