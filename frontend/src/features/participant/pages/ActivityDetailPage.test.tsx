import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllSessions, stubApi, unstubApi } from '../../../test/mockApi';
import { ActivityDetailPage } from './ActivityDetailPage';

/**
 * 公开活动详情页测试（FR-ACT-003/005/007 前端侧）。
 * 覆盖：未登录可看、报名开放状态与剩余名额展示、未开放原因分支、
 * 非公开活动（404/403）展示与标题稳定性（路由契约）。
 */

function detailBody(overrides: Record<string, unknown> = {}) {
  return {
    activity: {
      id: 'act1',
      title: '八月光影茶话会',
      activity_code: 'CC_SG_202608_01',
      description: '一场关于光影与倾诉的聚会。',
      location: '三楼活动室',
      start_time: '2026-08-10 02:00:00.000Z',
      end_time: '2026-08-10 04:00:00.000Z',
      status: 'published',
      capacity_total: 20,
      capacity_speaker: 10,
      capacity_listener: 10,
    },
    registration: {
      open: true,
      reason: null,
      remaining_total: 5,
      remaining_speaker: 2,
      remaining_listener: 3,
    },
    registration_fields: [],
    ...overrides,
  };
}

function renderDetail(activityId = 'act1') {
  return render(
    <MemoryRouter initialEntries={[`/a/${activityId}`]}>
      <Routes>
        <Route path="/a/:activityId" element={<ActivityDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ActivityDetailPage 公开活动详情', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('未登录可看：展示活动信息、剩余名额与报名入口（FR-ACT-003）', async () => {
    stubApi({ 'GET /api/cc/public/activities/': { body: detailBody() } });
    renderDetail();
    expect(await screen.findByText('八月光影茶话会')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '公开活动详情' })).toBeInTheDocument();
    expect(screen.getByText('三楼活动室')).toBeInTheDocument();
    expect(screen.getByText(/总名额剩余 5 个/)).toBeInTheDocument();
    expect(screen.getByText(/倾诉者剩余 2 个名额/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '立即报名' })).toHaveAttribute('href', '/a/act1/register');
  });

  it('报名未开放：按原因展示（名额已满）', async () => {
    stubApi({
      'GET /api/cc/public/activities/': {
        body: detailBody({
          registration: { open: false, reason: 'full' },
        }),
      },
    });
    renderDetail();
    expect(await screen.findByText('名额已满')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '立即报名' })).not.toBeInTheDocument();
  });

  it('活动不存在或未公开：404 展示兜底文案，标题保持稳定', async () => {
    stubApi({
      'GET /api/cc/public/activities/': {
        status: 404,
        body: { message: 'not found', data: {} },
      },
    });
    renderDetail();
    expect(await screen.findByText('活动不存在或未开放')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '公开活动详情' })).toBeInTheDocument();
  });
});
