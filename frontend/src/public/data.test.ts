// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicDataClient, PublicNotFoundError, UpstreamError } from './data';

/**
 * 公开数据加载单测（mock globalThis.fetch）：
 * 白名单字段收窄、404/超时/并发/大小上限、分页循环与截断标记。
 */

const CONFIG = { pbBaseUrl: 'http://pb.test', timeoutMs: 1000, maxInflight: 32 };

function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    text: async () => text,
  } as unknown as Response;
}

function activityRaw(extra: Record<string, unknown> = {}) {
  return {
    id: 'act1',
    title: '八月光影茶话会',
    activity_code: 'CC_SG_202608_01',
    description: '一场关于光影与倾诉的聚会。',
    location: '三楼活动室',
    start_time: '2026-08-10 02:00:00.000Z',
    end_time: '2026-08-10 04:00:00.000Z',
    status: 'published',
    capacity_total: 20,
    capacity_speaker: 10,
    capacity_listener: 10,
    registration: { open: true, reason: null, remaining_total: 5 },
    ...extra,
  };
}

function postRaw(extra: Record<string, unknown> = {}) {
  return {
    id: 'post1',
    title: '首场活动回顾',
    summary: '摘要',
    cover: 'cover.png',
    body_md: '# 正文',
    external_url: 'https://example.com/post1',
    is_pinned: false,
    published_at: '2026-08-01 00:00:00.000Z',
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('白名单字段收窄', () => {
  it('活动列表：敏感/内部字段被剔除', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          activities: [
            activityRaw({
              phone: '13800001111',
              organization_id: 'org1',
              checkin_qr_token: 'secret-token',
              registration: {
                open: true,
                reason: null,
                remaining_total: 5,
                internal_note: '内部备注',
              },
            }),
          ],
        }),
      ),
    );
    const client = createPublicDataClient(CONFIG);
    const [item] = await client.fetchPublicActivities('current');
    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain('13800001111');
    expect(serialized).not.toContain('org1');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('internal_note');
    expect(item).toEqual({
      id: 'act1',
      title: '八月光影茶话会',
      activity_code: 'CC_SG_202608_01',
      description: '一场关于光影与倾诉的聚会。',
      location: '三楼活动室',
      start_time: '2026-08-10 02:00:00.000Z',
      end_time: '2026-08-10 04:00:00.000Z',
      status: 'published',
      capacity_total: 20,
      registration: { open: true, reason: null, remaining_total: 5 },
    });
  });

  it('活动详情：registration_fields 不进入 DTO', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          activity: activityRaw({ next_speaker_sequence: 7 }),
          registration: {
            open: false,
            reason: 'full',
            remaining_total: 0,
            remaining_speaker: 0,
            remaining_listener: 0,
          },
          registration_fields: [{ id: 'f1', label: '身份证号', is_sensitive: true }],
        }),
      ),
    );
    const client = createPublicDataClient(CONFIG);
    const detail = await client.fetchPublicActivity('act1');
    expect(JSON.stringify(detail)).not.toContain('身份证');
    expect(JSON.stringify(detail)).not.toContain('next_speaker_sequence');
    expect('registration_fields' in detail).toBe(false);
    expect(detail.registration).toEqual({
      open: false,
      reason: 'full',
      remaining_total: 0,
      remaining_speaker: 0,
      remaining_listener: 0,
    });
  });

  it('推文：created_by/updated_by/status/系统字段被剔除', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          postRaw({
            created_by: 'super1',
            updated_by: 'super2',
            status: 'visible',
            created: '2026-08-01 00:00:00.000Z',
            updated: '2026-08-02 00:00:00.000Z',
          }),
        ),
      ),
    );
    const client = createPublicDataClient(CONFIG);
    const post = await client.fetchPublicPost('post1');
    const serialized = JSON.stringify(post);
    expect(serialized).not.toContain('super1');
    expect(serialized).not.toContain('super2');
    expect(post).toEqual({
      id: 'post1',
      title: '首场活动回顾',
      summary: '摘要',
      cover: 'cover.png',
      body_md: '# 正文',
      external_url: 'https://example.com/post1',
      is_pinned: false,
      published_at: '2026-08-01 00:00:00.000Z',
    });
  });
});

describe('URL 构造', () => {
  it('id 拼 URL 前 encodeURIComponent；列表带 scope', async () => {
    const fetchMock = vi.fn<(url: RequestInfo | URL) => Promise<Response>>(async () =>
      jsonResponse(postRaw()),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createPublicDataClient(CONFIG);
    await client.fetchPublicPost('a/b?x');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://pb.test/api/collections/posts/records/a%2Fb%3Fx',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        expect(String(url)).toBe('http://pb.test/api/cc/public/activities?scope=past');
        return jsonResponse({ activities: [] });
      }),
    );
    await createPublicDataClient(CONFIG).fetchPublicActivities('past');
  });

  it('pbBaseUrl 尾斜杠归一化', async () => {
    const fetchMock = vi.fn<(url: RequestInfo | URL) => Promise<Response>>(async () =>
      jsonResponse({ activities: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await createPublicDataClient({ ...CONFIG, pbBaseUrl: 'http://pb.test/' }).fetchPublicActivities(
      'current',
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://pb.test/api/cc/public/activities?scope=current',
    );
  });
});

describe('错误口径', () => {
  it('详情 404 → PublicNotFoundError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ message: 'not found' }, 404)),
    );
    const client = createPublicDataClient(CONFIG);
    await expect(client.fetchPublicActivity('nope')).rejects.toBeInstanceOf(PublicNotFoundError);
    await expect(client.fetchPublicPost('nope')).rejects.toBeInstanceOf(PublicNotFoundError);
  });

  it('列表非 2xx（含 404）→ UpstreamError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ message: 'x' }, 500)),
    );
    const client = createPublicDataClient(CONFIG);
    await expect(client.fetchPublicActivities('current')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('超时/网络错误 → UpstreamError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation timed out', 'TimeoutError');
      }),
    );
    const client = createPublicDataClient(CONFIG);
    await expect(client.fetchPublicActivities('current')).rejects.toBeInstanceOf(UpstreamError);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(client.fetchPublicPost('post1')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('JSON 解析失败 → UpstreamError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: null,
        text: async () => 'not-json{',
      })),
    );
    const client = createPublicDataClient(CONFIG);
    await expect(client.fetchPublicActivities('current')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('响应体超过 maxBytes → UpstreamError', async () => {
    const big = 'x'.repeat(2048);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(big));
            controller.close();
          },
        }),
        text: async () => big,
      })),
    );
    const client = createPublicDataClient({ ...CONFIG, maxBytes: 1024 });
    await expect(client.fetchPublicActivities('current')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('并发超限 → 直接抛 UpstreamError（不排队）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate;
        return jsonResponse({ activities: [] });
      }),
    );
    const client = createPublicDataClient({ ...CONFIG, maxInflight: 1 });
    const first = client.fetchPublicActivities('current');
    await expect(client.fetchPublicActivities('current')).rejects.toBeInstanceOf(UpstreamError);
    release();
    await expect(first).resolves.toEqual([]);
  });

  it('响应格式异常（缺必填字段）→ UpstreamError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ activities: [{ id: 'x' }] })),
    );
    const client = createPublicDataClient(CONFIG);
    await expect(client.fetchPublicActivities('current')).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('分页', () => {
  it('fetchAllPublicPostIdsForSitemap 循环翻页直至不满页，且只取 id 字段', async () => {
    const pages: Record<number, unknown[]> = {
      1: Array.from({ length: 100 }, (_, i) => postRaw({ id: `p${i}` })),
      2: Array.from({ length: 100 }, (_, i) => postRaw({ id: `p${100 + i}` })),
      3: Array.from({ length: 30 }, (_, i) => postRaw({ id: `p${200 + i}` })),
    };
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const parsed = new URL(String(url));
      const page = Number(parsed.searchParams.get('page'));
      return jsonResponse({
        page,
        perPage: 100,
        totalItems: 230,
        totalPages: 3,
        items: pages[page] ?? [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = createPublicDataClient(CONFIG);
    const { ids, truncated } = await client.fetchAllPublicPostIdsForSitemap();
    expect(ids).toHaveLength(230);
    expect(truncated).toBe(false);
    expect(ids[0]).toBe('p0');
    expect(ids[229]).toBe('p229');
    // sitemap 只需要 id：fields 收窄避免累积正文越过响应大小上限
    for (const call of fetchMock.mock.calls) {
      expect(new URL(String(call[0])).searchParams.get('fields')).toBe('id');
    }
  });

  it('超过 500 硬上限截断并标记 truncated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const page = Number(new URL(String(url)).searchParams.get('page'));
        return jsonResponse({
          page,
          perPage: 100,
          totalItems: 9999,
          totalPages: 100,
          items: Array.from({ length: 100 }, (_, i) => postRaw({ id: `p${(page - 1) * 100 + i}` })),
        });
      }),
    );
    const client = createPublicDataClient(CONFIG);
    const { ids, truncated } = await client.fetchAllPublicPostIdsForSitemap();
    expect(ids).toHaveLength(500);
    expect(truncated).toBe(true);
  });

  it('fetchPublicPosts(limit) 取单页，列表请求不拉 body_md 全文', async () => {
    const fetchMock = vi.fn<(url: RequestInfo | URL) => Promise<Response>>(async () =>
      jsonResponse({ page: 1, perPage: 2, totalItems: 10, totalPages: 5, items: [postRaw()] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createPublicDataClient(CONFIG);
    const posts = await client.fetchPublicPosts(2);
    expect(posts).toHaveLength(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('perPage')).toBe('2');
    const fields = url.searchParams.get('fields') ?? '';
    expect(fields).toContain('title');
    expect(fields).not.toContain('body_md');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
