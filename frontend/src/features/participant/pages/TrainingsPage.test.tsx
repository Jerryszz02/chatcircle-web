import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllSessions, saveParticipantSession, stubApi, unstubApi } from '../../../test/mockApi';
import { TrainingsPage } from './TrainingsPage';

/**
 * 聆听者培训页测试。
 * 覆盖：未获资格空态、流程说明 + 培训列表（状态徽标 / 我的状态：未参加·已通过·revoked 视为未参加）、
 * 已完成培训资质标记、空列表占位。
 */

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/trainings']}>
      <Routes>
        <Route path="/trainings" element={<TrainingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TrainingsPage 聆听者培训', () => {
  beforeEach(() => {
    clearAllSessions();
    saveParticipantSession();
  });
  afterEach(unstubApi);

  it('未获资格（eligible=false）：空态引导报名聆听者，不渲染列表', async () => {
    stubApi({
      'GET /api/cc/me/trainings': { body: { eligible: false, trained: false, trainings: [] } },
    });
    renderPage();
    expect(await screen.findByText('培训功能暂未开放')).toBeInTheDocument();
    expect(screen.getByText(/报名聆听者并通过审核后开放培训功能/)).toBeInTheDocument();
    expect(screen.queryByText('培训列表')).not.toBeInTheDocument();
  });

  it('已获资格：流程说明 + 培训列表与我的状态（revoked 视为未参加）', async () => {
    stubApi({
      'GET /api/cc/me/trainings': {
        body: {
          eligible: true,
          trained: false,
          trainings: [
            {
              id: 't1',
              title: '聆听基础培训',
              training_code: 'TR_01',
              start_time: '2026-09-01 02:00:00.000Z',
              end_time: '2026-09-01 04:00:00.000Z',
              location: '线上',
              status: 'published',
              my_attendance: null,
            },
            {
              id: 't2',
              title: '进阶培训',
              training_code: 'TR_02',
              start_time: '2026-08-01 02:00:00.000Z',
              end_time: '2026-08-01 04:00:00.000Z',
              status: 'closed',
              my_attendance: { status: 'valid', checked_in_at: '2026-08-01 02:05:00.000Z' },
            },
            {
              id: 't3',
              title: '早期培训',
              training_code: 'TR_00',
              start_time: '2026-07-01 02:00:00.000Z',
              end_time: '2026-07-01 04:00:00.000Z',
              status: 'closed',
              my_attendance: { status: 'revoked', checked_in_at: '2026-07-01 02:05:00.000Z' },
            },
          ],
        },
      },
    });
    renderPage();
    expect(await screen.findByText('培训流程')).toBeInTheDocument();
    expect(screen.getByText('聆听基础培训')).toBeInTheDocument();
    expect(screen.getByText('进阶培训')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getAllByText('已结束')).toHaveLength(2);
    // t1（null）与 t3（revoked）均为未参加；t2 valid 显示已通过 + 签到时间
    expect(screen.getAllByText(/未参加/)).toHaveLength(2);
    expect(screen.getByText(/已通过（签到于/)).toBeInTheDocument();
    // trained=false：不显示资质标记
    expect(screen.queryByText('已完成聆听者培训')).not.toBeInTheDocument();
  });

  it('trained=true：显示「已完成聆听者培训」资质标记；空列表有占位', async () => {
    stubApi({
      'GET /api/cc/me/trainings': { body: { eligible: true, trained: true, trainings: [] } },
    });
    renderPage();
    expect(await screen.findByText('已完成聆听者培训')).toBeInTheDocument();
    expect(screen.getByText(/暂无培训安排/)).toBeInTheDocument();
  });
});
