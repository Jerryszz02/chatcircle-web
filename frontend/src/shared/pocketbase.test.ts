import { afterEach, describe, expect, it, vi } from 'vitest';
import { PB_URL, pb } from './pocketbase';

describe('pocketbase client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未设置 VITE_PB_URL 时使用本地默认地址', () => {
    expect(PB_URL).toBe('http://127.0.0.1:8090');
  });

  it('pb client 以 PB_URL 初始化', () => {
    expect(pb.baseUrl).toBe(PB_URL);
  });

  it('关闭 autoCancellation（StrictMode 重复请求不应相互取消）', () => {
    expect((pb as unknown as { enableAutoCancellation: boolean }).enableAutoCancellation).toBe(
      false,
    );
  });

  it('send 前剔除 undefined 查询参数（filter=undefined 会触发服务端 400）', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({ page: 1, perPage: 20, totalItems: 0, totalPages: 0, items: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    await pb.collection('activities').getList(1, 20, { filter: undefined, sort: '-created' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('undefined');
    expect(calls[0]).toContain('sort=-created');
  });
});
