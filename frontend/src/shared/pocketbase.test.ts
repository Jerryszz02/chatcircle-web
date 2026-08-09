import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTestToken } from '../test/mockApi';
import { PB_URL, pb, pbClients } from './pocketbase';

describe('pocketbase client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未设置 VITE_PB_URL（本地 dev，经 vite /api 代理）时回退当前站点 origin', () => {
    // 回归：baseUrl 不能是 undefined/空串——SDK 会把请求拼到当前页面 pathname 之后
    expect(PB_URL).toBe(window.location.origin);
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

describe('管理端 401 统一处理（会话失效 → 清会话 + 跳登录页）', () => {
  function stubStatus(status: number) {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ message: 'unauthorized', data: {} }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
  }

  function saveAdminSession() {
    pbClients.admin.authStore.save(makeTestToken(), {
      id: 'admin_test',
      collectionName: 'admin_accounts',
    } as never);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.values(pbClients).forEach((c) => c.authStore.clear());
  });

  it('admin 普通请求 401：清除 admin 会话，错误原样抛出（跳转由 window.location 承担）', async () => {
    saveAdminSession();
    stubStatus(401);
    await expect(pbClients.admin.collection('activities').getList(1, 20)).rejects.toMatchObject({
      status: 401,
    });
    expect(pbClients.admin.authStore.isValid).toBe(false);
  });

  it('admin 认证类请求 401（登录/邀请码注册失败）：不清会话、不跳转（防登录页死循环）', async () => {
    saveAdminSession();
    stubStatus(401);
    await expect(
      pbClients.admin.collection('admin_accounts').authWithPassword('someone', 'wrong-password'),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      pbClients.admin.send('/api/cc/auth/admin-register', { method: 'POST', body: {} }),
    ).rejects.toMatchObject({ status: 401 });
    expect(pbClients.admin.authStore.isValid).toBe(true);
  });

  it('admin 请求 403（非会话失效）：不清会话', async () => {
    saveAdminSession();
    stubStatus(403);
    await expect(pbClients.admin.collection('activities').getList(1, 20)).rejects.toMatchObject({
      status: 403,
    });
    expect(pbClients.admin.authStore.isValid).toBe(true);
  });

  it('participant 请求 401：不在共享层跳转/清会话（由各页面 isUnauthorized 分支处理）', async () => {
    pbClients.participant.authStore.save(makeTestToken(), {
      id: 'pt_test',
      collectionName: 'participant_accounts',
    } as never);
    stubStatus(401);
    await expect(
      pbClients.participant.send('/api/cc/me/overview', { method: 'GET' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(pbClients.participant.authStore.isValid).toBe(true);
  });
});
