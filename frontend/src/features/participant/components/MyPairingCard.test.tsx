import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllSessions, saveParticipantSession, stubApi, unstubApi } from '../../../test/mockApi';
import { ApiError } from '../../../shared/api/http';
import type { MyPairingResponse } from '../../../shared/api/accountEvent';
import { MyPairingCard, MyPairingCardView } from './MyPairingCard';

/**
 * 「我的现场编号」配对卡测试（T5，PRD §5.3 前端侧）。
 * 覆盖五种已签到状态的展示、点开卡片查看组号与搭档、未签到/无报名隐藏卡片。
 * 测试环境（jsdom）无 EventSource，Realtime 订阅走降级路径：一次性快照 + 离线提示。
 */

function myPairingBody(overrides: Partial<MyPairingResponse> = {}): MyPairingResponse {
  return {
    contract_version: '2026-08-28.t0-v1',
    activity_id: 'act1',
    state: 'waiting_to_start',
    onsite_code: 'S01',
    updated_at: '2026-08-29T08:00:00Z',
    ...overrides,
  };
}

function stubMyPairing(body: unknown, status = 200) {
  return stubApi({ 'GET /api/cc/activities/act1/my-pairing': { status, body } });
}

describe('MyPairingCard 我的现场编号卡片（T5）', () => {
  beforeEach(() => {
    clearAllSessions();
    saveParticipantSession();
  });
  afterEach(unstubApi);

  it('配对未开始：本人现场编号 + 等待工作人员开始配对提示', async () => {
    stubMyPairing(myPairingBody({ onsite_code: 'S02' }));
    render(<MyPairingCard activityId="act1" />);
    expect(await screen.findByText('S02')).toBeInTheDocument();
    expect(screen.getByText('我的现场编号')).toBeInTheDocument();
    expect(screen.getByText('等待开始配对')).toBeInTheDocument();
    expect(screen.getByText(/等待工作人员开始配对/)).toBeInTheDocument();
    // 等待状态没有组号/搭档可看，不提供展开入口
    expect(screen.queryByRole('button', { name: /组号与搭档/ })).not.toBeInTheDocument();
  });

  it('配对已开始、对侧暂无人：提示正在等待搭档', async () => {
    stubMyPairing(myPairingBody({ state: 'waiting_for_partner' }));
    render(<MyPairingCard activityId="act1" />);
    expect(await screen.findByText('正在等待搭档')).toBeInTheDocument();
    expect(screen.getByText(/暂时没有可配对的搭档/)).toBeInTheDocument();
    expect(screen.getByText('S01')).toBeInTheDocument();
  });

  it('已配对：默认展示本人编号，点开卡片查看组号与搭档（文字+图标，不只靠颜色）', async () => {
    stubMyPairing(
      myPairingBody({
        state: 'paired',
        pair_code: 'P03',
        onsite_code: 'S02',
        partner: { onsite_code: 'L05', display_name: '王小明' },
      }),
    );
    render(<MyPairingCard activityId="act1" />);
    expect(await screen.findByText('已配对')).toBeInTheDocument();
    expect(screen.getByText('S02')).toBeInTheDocument();
    // 组号与搭档默认折叠
    expect(screen.queryByText('P03')).not.toBeInTheDocument();
    expect(screen.queryByText('王小明')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: '查看组号与搭档' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: '收起配对详情' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('配对组号')).toBeInTheDocument();
    expect(screen.getByText('P03')).toBeInTheDocument();
    expect(screen.getByText('搭档编号')).toBeInTheDocument();
    expect(screen.getByText('L05')).toBeInTheDocument();
    // 搭档本次报名姓名可见；不展示手机号
    expect(screen.getByText('搭档姓名')).toBeInTheDocument();
    expect(screen.getByText('王小明')).toBeInTheDocument();
    expect(screen.queryByText(/1[0-9]{10}/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '收起配对详情' }));
    expect(screen.queryByText('P03')).not.toBeInTheDocument();
  });

  it('已调整：明确提示安排已更新，展示新组号与新搭档', async () => {
    stubMyPairing(
      myPairingBody({
        state: 'reassigned',
        pair_code: 'P07',
        onsite_code: 'S02',
        partner: { onsite_code: 'L09', display_name: '李新' },
      }),
    );
    render(<MyPairingCard activityId="act1" />);
    expect(await screen.findByText('安排已更新')).toBeInTheDocument();
    expect(screen.getByText(/配对安排已更新/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '查看组号与搭档' }));
    expect(screen.getByText('P07')).toBeInTheDocument();
    expect(screen.getByText('L09')).toBeInTheDocument();
    expect(screen.getByText('李新')).toBeInTheDocument();
  });

  it('签到已撤销：配对信息不可用，提示联系现场工作人员，不展示旧编号', async () => {
    stubMyPairing(myPairingBody({ state: 'checkin_revoked', onsite_code: 'S03' }));
    render(<MyPairingCard activityId="act1" />);
    expect(await screen.findByText('签到已撤销')).toBeInTheDocument();
    expect(screen.getByText(/配对信息不可用/)).toBeInTheDocument();
    expect(screen.getByText(/联系现场工作人员/)).toBeInTheDocument();
    expect(screen.queryByText('S03')).not.toBeInTheDocument();
  });

  it('未签到（not_checked_in）：不渲染卡片', async () => {
    const mock = stubMyPairing(myPairingBody({ state: 'not_checked_in', onsite_code: undefined }));
    const { container } = render(<MyPairingCard activityId="act1" />);
    await waitFor(() => expect(mock.calls.length).toBeGreaterThan(0));
    expect(container).toBeEmptyDOMElement();
  });

  it('无本人报名（404）：不渲染卡片', async () => {
    const mock = stubMyPairing({ message: '活动或本人报名不存在', data: { code: 'not_found' } }, 404);
    const { container } = render(<MyPairingCard activityId="act1" />);
    await waitFor(() => expect(mock.calls.length).toBeGreaterThan(0));
    expect(container).toBeEmptyDOMElement();
  });

  it('未登录：不渲染卡片也不发请求', async () => {
    clearAllSessions();
    const mock = stubMyPairing(myPairingBody());
    const { container } = render(<MyPairingCard activityId="act1" />);
    expect(container).toBeEmptyDOMElement();
    expect(mock.calls).toHaveLength(0);
  });

  it('服务端异常：展示错误与重试入口', async () => {
    stubMyPairing({ message: '服务器繁忙', data: {} }, 500);
    render(<MyPairingCard activityId="act1" />);
    expect(await screen.findByText('服务器繁忙')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('Realtime 不可用（测试环境无 EventSource）时降级并提示离线状态', async () => {
    stubMyPairing(myPairingBody());
    render(<MyPairingCard activityId="act1" />);
    expect(await screen.findByText('S01')).toBeInTheDocument();
    expect(screen.getByText(/实时连接已断开/)).toBeInTheDocument();
  });

  it('后台刷新失败：保留旧快照并明确提示可能不是最新，提供重试入口', () => {
    const onRetry = vi.fn();
    render(
      <MyPairingCardView
        snapshot={myPairingBody({
          state: 'paired',
          pair_code: 'P03',
          onsite_code: 'S02',
          partner: { onsite_code: 'L05', display_name: '王小明' },
        })}
        status="online"
        error={new ApiError('无法连接服务器，请检查网络后重试', 0, 'NETWORK_ERROR')}
        loading={false}
        onRetry={onRetry}
      />,
    );
    // 旧配对内容仍可见，但带明确的陈旧提示与重试入口，不静默展示过期配对
    expect(screen.getByText('已配对')).toBeInTheDocument();
    expect(screen.getByText('S02')).toBeInTheDocument();
    expect(screen.getByText(/可能不是最新状态/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新获取' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
