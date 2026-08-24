import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllSessions, saveParticipantSession, stubApi, unstubApi } from '../../../test/mockApi';
import { TrainingCheckinPage } from './TrainingCheckinPage';

/**
 * 培训扫码签到页状态分支测试（照搬活动签到页用例）。
 * 覆盖：签到成功（body 携带 checkin_qr_token）、兼容 attendance/checkin 两种响应键、
 * 幂等返回已签到、未开放/已结束/聆听者报名未通过分因展示、失败重试。
 */

function renderCheckin(token = 'tok1') {
  return render(
    <MemoryRouter initialEntries={[`/training-checkin/${token}`]}>
      <Routes>
        <Route path="/training-checkin/:token" element={<TrainingCheckinPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TrainingCheckinPage 培训扫码签到', () => {
  beforeEach(() => {
    clearAllSessions();
    saveParticipantSession();
  });
  afterEach(unstubApi);

  it('签到成功：展示结果与时间，请求体携带 checkin token', async () => {
    const mock = stubApi({
      'POST /api/cc/training-checkin/self': {
        body: {
          attendance: { id: 'ta1', checked_in_at: '2026-08-05 12:30:00.000Z', status: 'valid' },
        },
      },
    });
    renderCheckin();
    expect(await screen.findByText('签到成功')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '培训签到' })).toBeInTheDocument();
    expect(mock.bodyOf(0)).toEqual({ token: 'tok1' });
  });

  it('响应键兼容：服务端沿用活动签到形态（checkin 键）也能正常展示', async () => {
    stubApi({
      'POST /api/cc/training-checkin/self': {
        body: {
          checkin: { id: 'ta1', checked_in_at: '2026-08-05 12:30:00.000Z', status: 'valid' },
        },
      },
    });
    renderCheckin();
    expect(await screen.findByText('签到成功')).toBeInTheDocument();
  });

  it('重复扫码：幂等返回既有记录，展示「已签到」不报错', async () => {
    stubApi({
      'POST /api/cc/training-checkin/self': {
        body: {
          attendance: { id: 'ta1', checked_in_at: '2026-08-05 12:30:00.000Z', status: 'valid' },
          already_checked_in: true,
        },
      },
    });
    renderCheckin();
    expect(await screen.findByText('您已签到')).toBeInTheDocument();
    expect(screen.getByText(/重复扫码不会产生新的签到记录/)).toBeInTheDocument();
  });

  it('签到未开放（checkin_not_open）', async () => {
    stubApi({
      'POST /api/cc/training-checkin/self': {
        status: 409,
        body: { message: '签到未开放', data: { code: 'checkin_not_open' } },
      },
    });
    renderCheckin();
    expect(await screen.findByText('签到未开放')).toBeInTheDocument();
  });

  it('签到已结束（checkin_closed）', async () => {
    stubApi({
      'POST /api/cc/training-checkin/self': {
        status: 409,
        body: { message: '签到已结束', data: { code: 'checkin_closed' } },
      },
    });
    renderCheckin();
    expect(await screen.findByText('签到已结束')).toBeInTheDocument();
  });

  it('聆听者报名未通过（listener_not_approved，403）：引导先报名聆听者', async () => {
    stubApi({
      'POST /api/cc/training-checkin/self': {
        status: 403,
        body: { message: '聆听者报名未通过', data: { code: 'listener_not_approved' } },
      },
    });
    renderCheckin();
    expect(await screen.findByText('暂未开放培训签到')).toBeInTheDocument();
    expect(screen.getByText(/报名聆听者并通过审核/)).toBeInTheDocument();
  });

  it('网络失败后可重试，重试成功展示签到结果', async () => {
    let attempt = 0;
    stubApi({
      'POST /api/cc/training-checkin/self': () => {
        attempt += 1;
        if (attempt === 1) {
          return { status: 500, body: { message: '服务器繁忙', data: {} } };
        }
        return {
          body: {
            attendance: { id: 'ta1', checked_in_at: '2026-08-05 12:30:00.000Z', status: 'valid' },
          },
        };
      },
    });
    renderCheckin();
    expect(await screen.findByText('签到失败')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('签到成功')).toBeInTheDocument();
    expect(attempt).toBe(2);
  });
});
