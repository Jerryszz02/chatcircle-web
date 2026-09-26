import type { PublicActivityDetailView, PublicActivitySummary, PublicPostView } from './types';

/**
 * 公开页服务端数据加载（仅 server/ 与测试 import；禁止进入浏览器 bundle）。
 *
 * 直接以匿名 fetch 访问 PocketBase 公开端点，不经过 pb SDK（无 window 依赖）：
 * - GET /api/cc/public/activities[?scope=current|past]（匿名可读的自定义端点）
 * - GET /api/cc/public/activities/:id
 * - GET /api/collections/posts/records（服务端 rule 只放行 visible）
 *
 * 防护：单请求超时（AbortSignal.timeout）、并发上限（超限直接抛 UpstreamError）、
 * 响应体大小上限、JSON 解析失败兜底。所有结果经白名单 mapper 收窄成
 * public/types.ts 的 DTO——registration_fields、created_by/updated_by、
 * 手机号等字段一律剔除，不得进入公开 HTML。
 */

/** 上游故障（网络/超时/5xx/响应异常）：服务端据此渲染 503。 */
export class UpstreamError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

/** 内容不存在或不可公开（上游 404）：服务端据此渲染 404 通用页，不泄露存在性。 */
export class PublicNotFoundError extends Error {
  constructor(message = '内容不存在或已下线') {
    super(message);
    this.name = 'PublicNotFoundError';
  }
}

export interface PublicDataConfig {
  /** PocketBase 内部地址（如 http://127.0.0.1:8090，不带尾斜杠）。 */
  pbBaseUrl: string;
  /** 单请求超时毫秒数（默认 5000）。 */
  timeoutMs?: number;
  /** 单响应体字节上限（默认 1MB）。 */
  maxBytes?: number;
  /** 同时在飞的上游请求上限（默认 32，超限直接抛 UpstreamError）。 */
  maxInflight?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_INFLIGHT = 32;

/** 公开推文排序：后台置顶优先，其余按首次发布时间倒序（与 participant/api.ts 口径一致）。 */
const PUBLIC_POSTS_SORT = '-is_pinned,-published_at';

/** sitemap 枚举推文的分页大小与硬上限。 */
const SITEMAP_PAGE_SIZE = 100;
const SITEMAP_MAX_POSTS = 500;

/* ---------- 白名单 mapper：只放行公开字段，其余一律丢弃 ---------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

type RegistrationReason = 'not_started' | 'ended' | 'closed' | 'full';

function asRegistrationReason(value: unknown): RegistrationReason | null {
  return value === 'not_started' || value === 'ended' || value === 'closed' || value === 'full'
    ? value
    : null;
}

function mapRegistration(value: unknown): PublicActivitySummary['registration'] {
  const reg = asRecord(value);
  if (!reg || typeof reg.open !== 'boolean') {
    throw new UpstreamError('上游响应格式异常（registration）');
  }
  return {
    open: reg.open,
    reason: asRegistrationReason(reg.reason),
    remaining_total: asNumber(reg.remaining_total) ?? null,
  };
}

function mapActivitySummary(value: unknown): PublicActivitySummary {
  const raw = asRecord(value);
  const id = asString(raw?.id);
  const title = asString(raw?.title);
  const activityCode = asString(raw?.activity_code);
  const startTime = asString(raw?.start_time);
  const endTime = asString(raw?.end_time);
  const status = asString(raw?.status);
  if (!raw || !id || !title || !activityCode || !startTime || !endTime || !status) {
    throw new UpstreamError('上游响应格式异常（activity）');
  }
  return {
    id,
    title,
    activity_code: activityCode,
    description: asString(raw.description),
    location: asString(raw.location),
    start_time: startTime,
    end_time: endTime,
    status: status as PublicActivitySummary['status'],
    capacity_total: asNumber(raw.capacity_total) ?? 0,
    registration: mapRegistration(raw.registration),
  };
}

/** 详情收窄：registration_fields 属报名编辑器数据，显式剔除，不进公开 HTML。 */
function mapActivityDetail(value: unknown): PublicActivityDetailView {
  const raw = asRecord(value);
  const activity = asRecord(raw?.activity);
  if (!raw || !activity) {
    throw new UpstreamError('上游响应格式异常（activity detail）');
  }
  const summary = mapActivitySummary({ ...activity, registration: raw.registration });
  const reg = asRecord(raw.registration);
  return {
    activity: {
      id: summary.id,
      title: summary.title,
      activity_code: summary.activity_code,
      description: summary.description,
      location: summary.location,
      start_time: summary.start_time,
      end_time: summary.end_time,
      status: summary.status,
      capacity_total: summary.capacity_total,
      capacity_speaker: asNumber(activity.capacity_speaker),
      capacity_listener: asNumber(activity.capacity_listener),
    },
    registration: {
      open: summary.registration.open,
      reason: summary.registration.reason ?? null,
      remaining_total: summary.registration.remaining_total,
      remaining_speaker: asNumber(reg?.remaining_speaker) ?? null,
      remaining_listener: asNumber(reg?.remaining_listener) ?? null,
    },
  };
}

/** 推文收窄：白名单字段之外（status/created_by/updated_by/系统字段）一律剔除。 */
function mapPost(value: unknown): PublicPostView {
  const raw = asRecord(value);
  const id = asString(raw?.id);
  const title = asString(raw?.title);
  if (!raw || !id || !title) {
    throw new UpstreamError('上游响应格式异常（post）');
  }
  return {
    id,
    title,
    summary: asString(raw.summary),
    cover: asString(raw.cover),
    body_md: asString(raw.body_md),
    external_url: asString(raw.external_url),
    is_pinned: raw.is_pinned === true,
    published_at: asString(raw.published_at),
  };
}

/** 服务端数据客户端（config 注入；并发上限状态随实例隔离，便于测试）。 */
export function createPublicDataClient(config: PublicDataConfig) {
  const baseUrl = config.pbBaseUrl.replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxInflight = config.maxInflight ?? DEFAULT_MAX_INFLIGHT;
  let inflight = 0;

  async function readBodyLimited(res: Response): Promise<string> {
    if (!res.body) return res.text();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamError('上游响应超过大小上限');
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  }

  /** kind=detail 时 404 映射为 PublicNotFoundError；其余非 2xx 一律 UpstreamError。 */
  async function fetchJson(path: string, kind: 'list' | 'detail'): Promise<unknown> {
    if (inflight >= maxInflight) {
      throw new UpstreamError('上游请求并发超限');
    }
    inflight += 1;
    try {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}${path}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // 网络错误与 AbortSignal.timeout 的 TimeoutError 同一口径
        throw new UpstreamError('上游服务暂时不可用');
      }
      const text = await readBodyLimited(res);
      if (res.status === 404 && kind === 'detail') {
        throw new PublicNotFoundError();
      }
      if (!res.ok) {
        throw new UpstreamError('上游服务暂时不可用', res.status);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new UpstreamError('上游响应不是合法 JSON');
      }
    } finally {
      inflight -= 1;
    }
  }

  async function fetchPostsPage(page: number, perPage: number): Promise<PublicPostView[]> {
    const raw = await fetchJson(
      `/api/collections/posts/records?page=${page}&perPage=${perPage}&sort=${encodeURIComponent(PUBLIC_POSTS_SORT)}`,
      'list',
    );
    const body = asRecord(raw);
    if (!body || !Array.isArray(body.items)) {
      throw new UpstreamError('上游响应格式异常（posts list）');
    }
    return (body.items as unknown[]).map(mapPost);
  }

  /**
   * 枚举全部公开推文（sitemap 用）：perPage=100 循环，硬上限 500；
   * 截断时返回 truncated=true（调用方记 warn 日志）。
   */
  async function fetchAllPublicPostsForSitemap(): Promise<{
    posts: PublicPostView[];
    truncated: boolean;
  }> {
    const posts: PublicPostView[] = [];
    let page = 1;
    for (;;) {
      const items = await fetchPostsPage(page, SITEMAP_PAGE_SIZE);
      posts.push(...items);
      if (items.length < SITEMAP_PAGE_SIZE) {
        return { posts, truncated: false };
      }
      // 满页且已达硬上限：可能还有剩余，标记截断
      if (posts.length >= SITEMAP_MAX_POSTS) {
        return { posts: posts.slice(0, SITEMAP_MAX_POSTS), truncated: true };
      }
      page += 1;
    }
  }

  return {
    /** 公开活动列表（scope='current' 仅未结束场次、'past' 仅已结束/已关闭场次）。 */
    async fetchPublicActivities(scope: 'current' | 'past'): Promise<PublicActivitySummary[]> {
      const raw = await fetchJson(`/api/cc/public/activities?scope=${scope}`, 'list');
      const body = asRecord(raw);
      if (!body || !Array.isArray(body.activities)) {
        throw new UpstreamError('上游响应格式异常（activities list）');
      }
      return (body.activities as unknown[]).map(mapActivitySummary);
    },

    /** 公开活动详情（404/不可公开 → PublicNotFoundError）。 */
    async fetchPublicActivity(id: string): Promise<PublicActivityDetailView> {
      const raw = await fetchJson(`/api/cc/public/activities/${encodeURIComponent(id)}`, 'detail');
      return mapActivityDetail(raw);
    },

    /**
     * 公开推文列表。传 limit 时取单页；不传则分页取全部（硬上限同 sitemap 口径）。
     */
    async fetchPublicPosts(limit?: number): Promise<PublicPostView[]> {
      if (limit !== undefined) {
        return fetchPostsPage(1, limit);
      }
      const { posts } = await fetchAllPublicPostsForSitemap();
      return posts;
    },

    fetchAllPublicPostsForSitemap,

    /** 公开推文详情（404/隐藏 → PublicNotFoundError，不泄露可见性）。 */
    async fetchPublicPost(id: string): Promise<PublicPostView> {
      const raw = await fetchJson(
        `/api/collections/posts/records/${encodeURIComponent(id)}`,
        'detail',
      );
      return mapPost(raw);
    },
  };
}

export type PublicDataClient = ReturnType<typeof createPublicDataClient>;
