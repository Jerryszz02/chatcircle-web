import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllSessions, saveParticipantSession, stubApi, unstubApi } from '../../../test/mockApi';
import { MePage } from './MePage';

/**
 * 「我的」中心测试（FR-PAR-001/002、AC-22 前端侧）。
 * 覆盖：报名状态列表、开放问卷入口（草稿续填）、已提交答卷索引、空状态；
 * T5：已签到报名条目内嵌「我的现场编号」配对卡（PRD §5.3 我的活动入口）。
 */

function overviewBody(overrides: Record<string, unknown> = {}) {
  return {
    registrations: [
      {
        registration: {
          id: 'reg1',
          activity_id: 'act1',
          participant_id: 'pt_test',
          activity_role: 'speaker',
          status: 'pending',
          submitted_at: '2026-08-01 10:00:00.000Z',
        },
        activity: {
          id: 'act1',
          title: '八月光影茶话会',
          activity_code: 'CC_SG_202608_01',
          start_time: '2026-08-10 02:00:00.000Z',
          end_time: '2026-08-10 04:00:00.000Z',
          status: 'published',
        },
      },
      {
        registration: {
          id: 'reg2',
          activity_id: 'act2',
          participant_id: 'pt_test',
          activity_role: 'listener',
          status: 'approved',
          submitted_at: '2026-08-02 10:00:00.000Z',
        },
        activity: {
          id: 'act2',
          title: '九月聆听工作坊',
          activity_code: 'CC_SG_202609_01',
          start_time: '2026-09-01 02:00:00.000Z',
          end_time: '2026-09-01 04:00:00.000Z',
          status: 'published',
        },
      },
    ],
    open_surveys: [
      {
        survey: {
          id: 'as1',
          title: '活动前测问卷',
          role_scope: 'both',
          status: 'open',
          qr_token: 'tok_1',
        },
        activity_title: '九月聆听工作坊',
        my_submission: { id: 'sub1', status: 'draft' },
      },
    ],
    submissions: [
      {
        submission: { id: 'sub0', status: 'submitted', submitted_at: '2026-08-03 12:00:00.000Z' },
        survey_title: '七月活动后测问卷',
        survey_qr_token: 'tok_0',
        activity_title: '七月分享会',
      },
    ],
    ...overrides,
  };
}

function renderMe() {
  return render(
    <MemoryRouter initialEntries={['/me']}>
      <Routes>
        <Route path="/me" element={<MePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MePage 我的中心', () => {
  beforeEach(() => {
    clearAllSessions();
    saveParticipantSession();
  });
  afterEach(unstubApi);

  it('展示报名状态列表、开放问卷入口与已提交答卷索引（FR-PAR-001/002）', async () => {
    stubApi({ 'GET /api/cc/me/overview': { body: overviewBody() } });
    renderMe();

    // 顶部提供返回首页入口
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveAttribute('href', '/');

    // 报名列表：状态与角色
    expect(await screen.findByText('八月光影茶话会')).toBeInTheDocument();
    expect(screen.getByText('待审核')).toBeInTheDocument();
    expect(screen.getByText('已通过')).toBeInTheDocument();
    expect(screen.getByText(/倾诉者/)).toBeInTheDocument();

    // 开放问卷：草稿可继续，入口指向问卷落地页
    expect(screen.getByText('活动前测问卷')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '继续填写' })).toHaveAttribute('href', '/survey/tok_1');

    // 已提交答卷：只读入口
    expect(screen.getByText('七月活动后测问卷')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看答案（只读）' })).toHaveAttribute(
      'href',
      '/survey/tok_0',
    );
  });

  it('空状态：三类信息各有占位文案', async () => {
    stubApi({
      'GET /api/cc/me/overview': {
        body: { registrations: [], open_surveys: [], submissions: [] },
      },
    });
    renderMe();
    expect(await screen.findByText(/暂无报名记录/)).toBeInTheDocument();
    expect(screen.getByText('当前没有可填写的问卷。')).toBeInTheDocument();
    expect(screen.getByText('还没有已提交的答卷。')).toBeInTheDocument();
  });

  it('聆听者报名已通过（has_approved_listener_registration）：显示培训入口卡片', async () => {
    stubApi({
      'GET /api/cc/me/overview': {
        body: overviewBody({ has_approved_listener_registration: true }),
      },
    });
    renderMe();
    expect(await screen.findByText('聆听者培训')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看培训' })).toHaveAttribute('href', '/trainings');
  });

  it('无已通过聆听者报名：不显示培训入口', async () => {
    stubApi({
      'GET /api/cc/me/overview': {
        body: overviewBody({ has_approved_listener_registration: false }),
      },
    });
    renderMe();
    expect(await screen.findByText('八月光影茶话会')).toBeInTheDocument();
    expect(screen.queryByText('聆听者培训')).not.toBeInTheDocument();
  });

  it('已通过的报名条目内嵌「我的现场编号」配对卡（T5，PRD §5.3 我的活动入口）', async () => {
    const mock = stubApi({
      'GET /api/cc/me/overview': { body: overviewBody() },
      'GET /api/cc/activities/act2/my-pairing': {
        body: {
          contract_version: '2026-08-28.t0-v1',
          activity_id: 'act2',
          state: 'paired',
          onsite_code: 'L02',
          pair_code: 'P02',
          partner: { onsite_code: 'S02', display_name: '陈搭档' },
          updated_at: '2026-08-29T08:00:00Z',
        },
      },
    });
    renderMe();
    // 已签到且已配对的展示编号、组号与搭档；共用一路订阅，不逐条各建
    expect(await screen.findByText('已配对')).toBeInTheDocument();
    expect(screen.getByText('我的现场编号')).toBeInTheDocument();
    expect(screen.getByText('L02')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看组号与搭档' }));
    expect(screen.getByText('P02')).toBeInTheDocument();
    expect(screen.getByText('陈搭档')).toBeInTheDocument();
    // 待审核报名（act1）不可能有现场签到与配对，不应发起 my-pairing 请求
    expect(mock.calls.filter((call) => call.url.includes('act1/my-pairing'))).toHaveLength(0);
  });
});
