import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityRecord, RegistrationRecord } from '../../../../shared/api/types';
import { unstubApi } from '../../../../test/mockApi';
import { RegistrationPanel } from './RegistrationPanel';

/**
 * 报名审核台列表加载竞态回归测试。
 *
 * 背景：审核提交后弹窗先关闭、随后才 await 旧页签 load 与父组件刷新；
 * 此时管理员（或 e2e 主链路）立刻切到「已通过」页签，两个 load 并发，
 * 若旧的慢响应后到达会把新页签的列表覆盖成旧页签结果
 * （e2e main-flow「管理员审核通过报名」曾因此断言 1 条实际 0 条）。
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

const approvedReg = {
  id: 'reg_approved',
  activity_id: 'act1',
  participant_id: 'pt_abc123def456',
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
});
