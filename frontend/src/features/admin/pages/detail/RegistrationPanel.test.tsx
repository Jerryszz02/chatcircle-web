import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityRecord, RegistrationRecord } from '../../../../shared/api/types';
import { unstubApi } from '../../../../test/mockApi';
import { RegistrationPanel } from './RegistrationPanel';

/**
 * 报名审核台列表加载竞态回归测试。
 *
 * 背景：审核提交后弹窗先关闭、随后才 await 旧页签 load 与父组件刷新；
 * 此时管理员（或 e2e 主链路）立刻切到「已通过」页签，两个 load 并发。
 * 场景一：旧页签请求先发出但慢响应后到达，不得覆盖新页签结果
 * （e2e main-flow「管理员审核通过报名」曾因此断言 1 条实际 0 条）。
 * 场景二：提交途中 Escape 关弹窗再切页签，submitTransition 续运调用旧页签
 * load 闭包且更晚发出，仅凭发出顺序会误认它为最新，同样不得覆盖。
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function listResponse(items: unknown[]): Response {
  return {
    status: 200,
    json: async () => ({ page: 1, perPage: 500, totalItems: items.length, totalPages: 1, items }),
  } as Response;
}

const activity = { id: 'act1' } as ActivityRecord;

const pendingReg = {
  id: 'reg_pending',
  activity_id: 'act1',
  participant_id: 'pt_pending_123456',
  activity_role: 'speaker',
  status: 'pending',
  status_reason: '',
  submitted_at: '2026-08-09 02:00:00.000Z',
} as RegistrationRecord;

const approvedReg = {
  id: 'reg_approved',
  activity_id: 'act1',
  participant_id: 'pt_approved_123456',
  activity_role: 'speaker',
  status: 'approved',
  status_reason: '',
  submitted_at: '2026-08-10 02:00:00.000Z',
} as RegistrationRecord;

function renderPanel() {
  return render(
    <RegistrationPanel
      activity={activity}
      counts={{ total: 1, speaker: 1, listener: 0 }}
      remaining={{ total: 9, speaker: 4, listener: 5 }}
      onChanged={() => {}}
    />,
  );
}

/** 按 filter 中的 status 分流报名列表请求；transition POST 挂起由调用方控制。 */
function stubRegistrationApi(transitionReq: { promise: Promise<Response> }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = decodeURIComponent(String(url));
      if (u.includes('/api/cc/registrations/') && u.includes('/transition')) {
        return transitionReq.promise;
      }
      if (u.includes('/api/collections/registrations/records')) {
        if (u.includes('status = "approved"')) {
          return Promise.resolve(listResponse([approvedReg]));
        }
        return Promise.resolve(listResponse([pendingReg]));
      }
      return Promise.resolve({
        status: 404,
        json: async () => ({ message: `未匹配的请求 ${init?.method ?? 'GET'} ${u}`, data: {} }),
      } as Response);
    }),
  );
}

describe('RegistrationPanel 报名审核台', () => {
  afterEach(unstubApi);

  it('切页签后旧页签的慢响应不得覆盖新页签列表', async () => {
    const pendingReq = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: RequestInfo | URL): Promise<Response> => {
        const u = decodeURIComponent(String(url));
        if (u.includes('/api/collections/registrations/records')) {
          if (u.includes('status = "approved"')) {
            return Promise.resolve(listResponse([approvedReg]));
          }
          // 「待审核」请求挂起，模拟慢响应
          return pendingReq.promise;
        }
        return Promise.resolve({
          status: 404,
          json: async () => ({ message: `未匹配的请求 ${u}`, data: {} }),
        } as Response);
      }),
    );

    renderPanel();

    // 初始「待审核」列表请求仍在途时切到「已通过」
    fireEvent.click(screen.getByRole('tab', { name: '已通过' }));
    await waitFor(() =>
      expect(document.querySelectorAll('.admin-table tbody tr')).toHaveLength(1),
    );

    // 慢的旧响应随后到达（空列表），不得覆盖当前页签结果
    await act(async () => {
      pendingReq.resolve(listResponse([]));
      await pendingReq.promise;
    });
    expect(document.querySelectorAll('.admin-table tbody tr')).toHaveLength(1);
    expect(screen.queryByText('当前状态下暂无报名记录。')).not.toBeInTheDocument();
  });

  it('提交途中关弹窗再切页签：续运触发的旧页签请求不得覆盖新页签列表', async () => {
    const transitionReq = deferred<Response>();
    stubRegistrationApi(transitionReq);
    renderPanel();

    // 待审核列表加载完成后发起审核通过
    await waitFor(() =>
      expect(document.querySelectorAll('.admin-table tbody tr')).toHaveLength(1),
    );
    fireEvent.click(screen.getByRole('button', { name: '通过' }));
    const dialog = screen.getByRole('dialog', { name: '审核通过' });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }));

    // transition 请求在途时 Escape 关闭弹窗，再切到「已通过」页签
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: '已通过' }));
    await waitFor(() =>
      expect(document.querySelector('.admin-table tbody')?.textContent).toContain('已通过'),
    );

    // transition 完成，submitTransition 续运调用旧页签（待审核）的 load 闭包：
    // 该请求更晚发出但口径已过期，不得把列表覆盖回待审核数据
    await act(async () => {
      transitionReq.resolve({ status: 200, json: async () => ({}) } as Response);
      await transitionReq.promise;
    });
    const tbody = document.querySelector('.admin-table tbody');
    expect(tbody?.textContent).toContain('已通过');
    expect(tbody?.textContent).not.toContain('待审核');
  });
});
