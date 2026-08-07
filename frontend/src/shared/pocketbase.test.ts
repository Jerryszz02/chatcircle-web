import { afterEach, describe, expect, it, vi } from 'vitest';
import { PB_URL, pb } from './pocketbase';

describe('pocketbase client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未设置 VITE_PB_URL 时使用本地默认地址', () => {
    expect(PB_URL).toBe('http://127.0.0.1:8090');
  });

  it('VITE_PB_URL 为空字符串（生产 Dockerfile 默认注入）时回退到当前站点 origin', async () => {
    // 回归：空 baseUrl 会被 SDK 拼到当前页面 pathname 之后（/login → /login/api/...），
    // 导致登录等全部 API 404；空字符串必须回退为绝对 origin。
    vi.stubEnv('VITE_PB_URL', '');
    vi.resetModules();
    try {
      const mod = await import('./pocketbase');
      expect(mod.PB_URL).toBe(window.location.origin);
      expect(mod.PB_URL.startsWith('http')).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
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
