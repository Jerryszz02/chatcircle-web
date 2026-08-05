import { vi } from 'vitest';
import { pbClients } from '../shared/pocketbase';

/**
 * 参与者端页面/组件测试用的 fetch mock helper（本文件归参与者端维护）。
 *
 * 用法：
 *   const mock = stubApi({
 *     'GET /api/cc/public/activities/': { body: {...} },
 *     'POST /api/cc/checkin/': (url, init) => ({ status: 409, body: {...} }),
 *   });
 *   ...afterEach(() => unstubApi());
 *
 * key 为「METHOD 路径片段」，按声明顺序首个匹配生效；未匹配返回 404。
 * 返回的 Response 形态与 shared/api/http.test.ts 中已验证的最小结构一致，
 * PocketBase SDK 可正常解析（status >= 400 时抛出 ClientResponseError）。
 */

export interface MockReply {
  /** HTTP 状态码，默认 200。 */
  status?: number;
  /** 响应 JSON body。错误响应用 PocketBase 形态：{ message, data: { code, ... } }。 */
  body?: unknown;
}

export type MockHandler =
  | MockReply
  | ((url: string, init?: RequestInit) => MockReply | undefined);

export interface ApiMock {
  /** 全部请求记录（按调用顺序），用于断言请求路径/body/次数。 */
  calls: Array<{ url: string; init?: RequestInit }>;
  /** 解析某次调用的 JSON body。 */
  bodyOf(callIndex: number): unknown;
}

export function stubApi(routes: Record<string, MockHandler>): ApiMock {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    calls.push({ url: u, init });
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const [key, handler] of Object.entries(routes)) {
      const sep = key.indexOf(' ');
      const m = key.slice(0, sep).toUpperCase();
      const path = key.slice(sep + 1);
      if (m !== method || !u.includes(path)) continue;
      const reply = typeof handler === 'function' ? handler(u, init) : handler;
      if (!reply) continue;
      return {
        url: u,
        status: reply.status ?? 200,
        json: async () => reply.body ?? {},
      } as Response;
    }
    return {
      url: u,
      status: 404,
      json: async () => ({ message: `mockApi: 未匹配的请求 ${method} ${u}`, data: {} }),
    } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return {
    calls,
    bodyOf(callIndex: number) {
      const raw = calls[callIndex]?.init?.body;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    },
  };
}

export function unstubApi(): void {
  vi.unstubAllGlobals();
}

/** 构造未过期假 JWT（与 shared/auth.test.ts 同构，签名不校验）。 */
export function makeTestToken(expOffsetSeconds = 3600): string {
  const b64 = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    exp: Math.floor(Date.now() / 1000) + expOffsetSeconds,
    id: 'test_record_id',
    type: 'authRecord',
    collectionId: 'test_collection',
  });
  return `${header}.${payload}.fake-signature`;
}

/** 写入一个有效的参与者会话（页面测试需要已登录态时使用）。 */
export function saveParticipantSession(id = 'pt_test', username = 'test_user'): void {
  pbClients.participant.authStore.save(makeTestToken(), {
    id,
    username,
    collectionName: 'participant_accounts',
  } as never);
}

/** 清空全部角色会话与 localStorage（beforeEach 使用）。 */
export function clearAllSessions(): void {
  localStorage.clear();
  Object.values(pbClients).forEach((c) => c.authStore.clear());
}
