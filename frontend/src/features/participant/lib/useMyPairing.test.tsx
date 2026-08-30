import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllSessions, saveParticipantSession, stubApi, unstubApi } from '../../../test/mockApi';
import { useMyPairing } from './useMyPairing';

/**
 * useMyPairing hook 行为（T5）：初始快照、后台刷新失败的陈旧快照保留、手动重试恢复。
 * 测试环境（jsdom）无 EventSource，Realtime 订阅走降级路径，重试经 reload 触发。
 */

const pairedBody = {
  contract_version: '2026-08-28.t0-v1',
  activity_id: 'act1',
  state: 'paired',
  onsite_code: 'S01',
  pair_code: 'P01',
  partner: { onsite_code: 'L01', display_name: '王小明' },
  updated_at: '2026-08-29T08:00:00Z',
};

describe('useMyPairing（T5）', () => {
  beforeEach(() => {
    clearAllSessions();
    saveParticipantSession();
  });
  afterEach(unstubApi);

  it('后台刷新失败保留旧快照并暴露错误；重试成功后清除错误', async () => {
    let fail = false;
    stubApi({
      'GET /api/cc/activities/act1/my-pairing': () =>
        fail ? { status: 500, body: { message: '服务器繁忙', data: {} } } : { body: pairedBody },
    });
    const { result } = renderHook(() => useMyPairing('act1'));
    await waitFor(() => expect(result.current.snapshot?.state).toBe('paired'));
    expect(result.current.error).toBeNull();

    // 模拟失效事件后的刷新失败：旧快照保留，错误暴露给 UI 做陈旧提示
    fail = true;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error?.message).toBe('服务器繁忙'));
    expect(result.current.snapshot?.state).toBe('paired');

    // 恢复后重试成功：错误清除，快照仍在
    fail = false;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.snapshot?.state).toBe('paired');
  });

  it('未登录时惰性：不发请求', () => {
    clearAllSessions();
    const mock = stubApi({ 'GET /api/cc/activities/act1/my-pairing': { body: pairedBody } });
    const { result } = renderHook(() => useMyPairing('act1'));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mock.calls).toHaveLength(0);
  });
});
