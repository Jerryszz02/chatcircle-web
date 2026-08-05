import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PocketBase, { ClientResponseError, LocalAuthStore } from 'pocketbase';
import { ApiError, apiGet, apiPost, normalizeApiError } from './http';

/** 每个用例独立 client，避免与全局单例互相影响。 */
const client = new PocketBase('http://127.0.0.1:8090', new LocalAuthStore('cc_test_http'));

function jsonResponse(status: number, body: unknown, url = 'http://127.0.0.1:8090/api/cc/test') {
  return {
    url,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  client.authStore.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeApiError 错误规范化', () => {
  it('HTTP 错误：保留 status、message 与字段级 details', () => {
    const err = new ClientResponseError({
      url: 'http://x/api/cc/test',
      status: 403,
      response: { message: '禁止访问', data: { code: 'forbidden' } },
    });
    const normalized = normalizeApiError(err);
    expect(normalized).toBeInstanceOf(ApiError);
    expect(normalized.code).toBe('HTTP_ERROR');
    expect(normalized.status).toBe(403);
    expect(normalized.message).toBe('禁止访问');
    expect(normalized.details).toEqual({ code: 'forbidden' });
  });

  it('网络错误（status=0）：规范化为 NETWORK_ERROR 且文案可读', () => {
    const normalized = normalizeApiError(new ClientResponseError({ status: 0 }));
    expect(normalized.code).toBe('NETWORK_ERROR');
    expect(normalized.status).toBe(0);
    expect(normalized.message).toContain('网络');
  });

  it('请求中止：规范化为 ABORTED', () => {
    const normalized = normalizeApiError(new ClientResponseError({ isAbort: true, status: 0 }));
    expect(normalized.code).toBe('ABORTED');
  });

  it('普通 Error 与未知异常均有兜底文案', () => {
    expect(normalizeApiError(new Error('boom')).message).toBe('boom');
    expect(normalizeApiError('weird').code).toBe('NETWORK_ERROR');
    const apiErr = new ApiError('已是规范化', 400, 'HTTP_ERROR');
    expect(normalizeApiError(apiErr)).toBe(apiErr);
  });
});

describe('apiFetch/apiGet/apiPost', () => {
  it('GET 成功返回解析后的 JSON，并携带 auth token', async () => {
    client.authStore.save('fake-token', { id: 'x' } as never);
    const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (url) => {
        expect(String(url)).toBe('http://127.0.0.1:8090/api/cc/health');
        return jsonResponse(200, { ok: true });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiGet<{ ok: boolean }>(client, '/api/cc/health');
    expect(res).toEqual({ ok: true });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('fake-token');
    expect(init.method).toBe('GET');
  });

  it('POST 序列化 JSON body；传入幂等键时带 Idempotency-Key 头', async () => {
    const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse(200, { id: 'reg_1' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await apiPost(
      client,
      '/api/cc/registrations',
      { activity_id: 'a1' },
      { idempotencyKey: 'k-1' },
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ activity_id: 'a1' }));
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Idempotency-Key']).toBe('k-1');
  });

  it('HTTP 400 错误被规范化为 ApiError 抛出', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, { message: '参数错误', data: { username: { code: 'invalid' } } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiGet(client, '/api/cc/bad')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'HTTP_ERROR',
      status: 400,
      message: '参数错误',
      details: { username: { code: 'invalid' } },
    });
  });

  it('网络异常被规范化为 NETWORK_ERROR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(apiGet(client, '/api/cc/health')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'NETWORK_ERROR',
      status: 0,
    });
  });
});
