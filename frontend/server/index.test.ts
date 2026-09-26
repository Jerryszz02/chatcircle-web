// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicServer } from './index';

/**
 * 公开页渲染服务集成测试（真起 server + 假上游 http server）。
 * 覆盖：SSR HTML 关键内容/转义、404 矩阵、上游故障降级（首页 200 / 详情 503）、
 * robots.txt / sitemap.xml / healthz / readyz、静态资源与缓存头、UA 一致性。
 */

const SITE_ORIGIN = 'https://chatcircle.test';

/** 假上游行为表：按「方法 + 路径前缀」匹配。 */
type UpstreamHandler = (url: URL) => { status?: number; body?: unknown } | 'hang' | undefined;

let upstreamHandlers: Record<string, UpstreamHandler> = {};
let upstreamServer: Server;
let upstreamPort: number;

let publicServer: Server;
let publicPort: number;
let clientDir: string;

const ACTIVITY = {
  id: 'act1',
  title: '八月光影茶话会',
  activity_code: 'CC_SG_202608_01',
  description: '一场关于光影与倾诉的聚会。',
  location: '三楼活动室',
  // 未结束场次（晚于请求时刻），会出现在首页/现有活动列表
  start_time: '2026-10-10 02:00:00.000Z',
  end_time: '2026-10-10 04:00:00.000Z',
  status: 'published',
  capacity_total: 20,
  capacity_speaker: 10,
  capacity_listener: 10,
  registration: { open: true, reason: null, remaining_total: 5 },
  // 以下字段必须被白名单收窄，不得出现在公开 HTML
  organization_id: 'org-internal',
  checkin_qr_token: 'qr-secret',
};

const ACTIVITY_DETAIL = {
  activity: ACTIVITY,
  registration: {
    open: true,
    reason: null,
    remaining_total: 5,
    remaining_speaker: 2,
    remaining_listener: 3,
  },
  registration_fields: [{ id: 'f1', label: '敏感报名字段', is_sensitive: true }],
};

const POST = {
  id: 'post1',
  title: '首场活动回顾',
  summary: '后台上传的活动回顾摘要。',
  cover: '',
  body_md: '# 回顾正文',
  external_url: '',
  is_pinned: false,
  status: 'visible',
  published_at: '2026-08-01 00:00:00.000Z',
  created_by: 'super-internal',
  updated_by: 'super-internal',
};

function defaultUpstream(url: URL): { status?: number; body?: unknown } | 'hang' | undefined {
  if (url.pathname === '/api/health') return { body: { code: 200 } };
  if (url.pathname === '/api/cc/public/activities' && url.searchParams.get('scope')) {
    return { body: { activities: [ACTIVITY] } };
  }
  if (url.pathname === '/api/cc/public/activities/act1') return { body: ACTIVITY_DETAIL };
  if (url.pathname === '/api/cc/public/activities/hang') return 'hang';
  if (url.pathname.startsWith('/api/cc/public/activities/')) {
    return { status: 404, body: { message: 'not found', data: {} } };
  }
  if (url.pathname === '/api/collections/posts/records') {
    return {
      body: { page: 1, perPage: 100, totalItems: 1, totalPages: 1, items: [POST] },
    };
  }
  if (url.pathname === '/api/collections/posts/records/post1') return { body: POST };
  if (url.pathname.startsWith('/api/collections/posts/records/')) {
    return { status: 404, body: { message: 'not found', data: {} } };
  }
  return { status: 404, body: { message: 'not found', data: {} } };
}

function makeClientDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-public-client-'));
  mkdirSync(join(dir, '.vite'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(
    join(dir, '.vite', 'manifest.json'),
    JSON.stringify({
      'src/entry-public-client.tsx': {
        file: 'assets/entry-public-client-test.js',
        isEntry: true,
        css: ['assets/entry-public-client-test.css'],
      },
    }),
  );
  writeFileSync(join(dir, 'assets', 'entry-public-client-test.js'), 'console.log(1);\n');
  writeFileSync(join(dir, 'assets', 'entry-public-client-test.css'), 'body{}\n');
  writeFileSync(join(dir, 'og-share.jpg'), 'fake-jpg');
  return dir;
}

async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const res = await fetch(`http://127.0.0.1:${publicPort}${path}`, { headers });
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: await res.text(),
  };
}

beforeAll(async () => {
  upstreamHandlers = {};
  upstreamServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://upstream');
    const handler = upstreamHandlers[`${req.method} ${url.pathname}`] ?? defaultUpstream;
    const reply = handler(url);
    if (reply === 'hang') return; // 永不响应，测试上游超时
    if (!reply) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'not found', data: {} }));
      return;
    }
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstreamServer.address() as AddressInfo).port;

  clientDir = makeClientDir();
  publicServer = createPublicServer({
    siteOrigin: SITE_ORIGIN,
    pbBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    fetchTimeoutMs: 800,
    maxInflight: 32,
    clientDir,
    logger: () => {},
  });
  await new Promise<void>((resolve) => publicServer.listen(0, '127.0.0.1', resolve));
  publicPort = (publicServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await Promise.all([
    new Promise((resolve) => publicServer.close(resolve)),
    new Promise((resolve) => upstreamServer.close(resolve)),
  ]);
  rmSync(clientDir, { recursive: true, force: true });
});

describe('SSR 页面', () => {
  it('GET / ：真实标题/正文/canonical/JSON-LD/__CC_PUBLIC_DATA__，Cache-Control no-store', async () => {
    const { status, headers, body } = await get('/');
    expect(status).toBe(200);
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['content-type']).toContain('text/html');
    expect(body).toContain('<title>Chat Circles · 青年心理健康公益项目</title>');
    expect(body).toContain('被真正听见');
    expect(body).toContain('八月光影茶话会');
    expect(body).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/"`);
    expect(body).toContain('"@type":"WebSite"');
    expect(body).toContain('"@type":"Organization"');
    expect(body).toContain('上海井畅企业管理咨询有限公司');
    expect(body).toContain('id="__CC_PUBLIC_DATA__"');
    // 白名单：内部字段不进入 HTML
    expect(body).not.toContain('org-internal');
    expect(body).not.toContain('qr-secret');
    expect(body).not.toContain('super-internal');
    // 客户端 bundle 与样式注入
    expect(body).toContain('/public-assets/assets/entry-public-client-test.js');
    expect(body).toContain('/public-assets/assets/entry-public-client-test.css');
  });

  it('GET /about：静态页标题与 OG', async () => {
    const { status, body } = await get('/about');
    expect(status).toBe(200);
    expect(body).toContain('<title>关于我们 · Chat Circles</title>');
    expect(body).toContain('关于 Chat Circles');
    expect(body).toContain('"@type":"AboutPage"');
    expect(body).toContain(
      `property="og:image" content="${SITE_ORIGIN}/public-assets/og-share.jpg"`,
    );
  });

  it('GET /a/act1：Event JSON-LD + 报名状态；registration_fields 不进 HTML', async () => {
    const { status, body } = await get('/a/act1');
    expect(status).toBe(200);
    expect(body).toContain('<title>八月光影茶话会 · Chat Circles</title>');
    expect(body).toContain('"@type":"Event"');
    expect(body).toContain('"startDate":"2026-10-10T02:00:00.000Z"');
    expect(body).not.toContain('eventStatus');
    expect(body).toContain('总名额剩余 5 个');
    expect(body).toContain('href="/a/act1/register"');
    expect(body).not.toContain('敏感报名字段');
    expect(body).not.toContain('registration_fields');
    // 会话岛屿不进 SSR
    expect(body).not.toContain('我的现场编号');
  });

  it('GET /posts/post1：Article JSON-LD + 正文', async () => {
    const { status, body } = await get('/posts/post1');
    expect(status).toBe(200);
    expect(body).toContain('<title>首场活动回顾 · Chat Circles</title>');
    expect(body).toContain('"@type":"Article"');
    expect(body).toContain('回顾正文');
    expect(body).not.toContain('super-internal');
  });

  it('data script 中 </script> 注入被转义', async () => {
    upstreamHandlers['GET /api/cc/public/activities'] = () => ({
      body: { activities: [{ ...ACTIVITY, title: 'X</script><script>alert(1)</script>' }] },
    });
    try {
      const { body } = await get('/');
      expect(body).not.toContain('</script><script>alert(1)</script>');
      // 正文经 React 转义；内嵌 data JSON 经 < → < 替换
      expect(body).toContain('X&lt;/script&gt;');
      expect(body).toContain('X\\u003c/script\\u003e');
    } finally {
      delete upstreamHandlers['GET /api/cc/public/activities'];
    }
  });

  it('普通 UA 与 OAI-SearchBot UA 响应体一致', async () => {
    const plain = await get('/');
    const bot = await get('/', { 'user-agent': 'OAI-SearchBot/1.0' });
    expect(bot.status).toBe(200);
    // generatedAt 逐请求生成，剔除后比较
    const strip = (html: string) => html.replace(/"generatedAt":"[^"]+"/g, '');
    expect(strip(bot.body)).toBe(strip(plain.body));
  });
});

describe('404 矩阵（不泄露存在性）', () => {
  it.each([
    '/a/nonexistent',
    '/a/draft-hidden',
    '/posts/hidden',
    '/nonexistent-path',
    '/a/act1/register',
    '/about/',
  ])('%s → 404 通用页 + noindex', async (path) => {
    const { status, body } = await get(path);
    expect(status).toBe(404);
    expect(body).toContain('内容不存在或已下线');
    expect(body).toContain('noindex');
    expect(body).toContain('返回首页');
    expect(body).not.toContain('__CC_PUBLIC_DATA__');
  });
});

describe('上游故障降级', () => {
  it('详情页上游超时 → 503 + Retry-After', async () => {
    const { status, headers, body } = await get('/a/hang');
    expect(status).toBe(503);
    expect(headers['retry-after']).toBe('30');
    expect(body).toContain('服务暂时不可用');
  });

  it('详情页上游 500 → 503', async () => {
    upstreamHandlers['GET /api/cc/public/activities/broken'] = () => ({
      status: 500,
      body: { message: 'boom', data: {} },
    });
    try {
      const { status } = await get('/a/broken');
      expect(status).toBe(503);
    } finally {
      delete upstreamHandlers['GET /api/cc/public/activities/broken'];
    }
  });

  it('首页上游全挂 → 200（静态介绍在 + 列表区错误态）', async () => {
    upstreamHandlers['GET /api/cc/public/activities'] = () => ({ status: 500, body: {} });
    upstreamHandlers['GET /api/collections/posts/records'] = () => ({ status: 500, body: {} });
    try {
      const { status, body } = await get('/');
      expect(status).toBe(200);
      expect(body).toContain('被真正听见');
      expect(body).toContain('内容暂时无法加载');
    } finally {
      delete upstreamHandlers['GET /api/cc/public/activities'];
      delete upstreamHandlers['GET /api/collections/posts/records'];
    }
  });

  it('sitemap 上游失败 → 503（不返回空 sitemap）', async () => {
    upstreamHandlers['GET /api/cc/public/activities'] = () => ({ status: 500, body: {} });
    try {
      const { status } = await get('/sitemap.xml');
      expect(status).toBe(503);
    } finally {
      delete upstreamHandlers['GET /api/cc/public/activities'];
    }
  });
});

describe('健康检查与静态资源', () => {
  it('/healthz 恒 200', async () => {
    const { status, body } = await get('/healthz');
    expect(status).toBe(200);
    expect(body).toBe('ok');
  });

  it('/readyz 上游通 200 / 断 503', async () => {
    expect((await get('/readyz')).status).toBe(200);
    upstreamHandlers['GET /api/health'] = () => ({ status: 503, body: {} });
    try {
      expect((await get('/readyz')).status).toBe(503);
    } finally {
      delete upstreamHandlers['GET /api/health'];
    }
  });

  it('/robots.txt：Disallow 清单 + GPTBot 训练退出 + Sitemap', async () => {
    const { status, headers, body } = await get('/robots.txt');
    expect(status).toBe(200);
    expect(headers['content-type']).toContain('text/plain');
    expect(body).toContain('Disallow: /admin');
    expect(body).toContain('Disallow: /api/');
    expect(body).toContain('Disallow: /a/*/register');
    expect(body).toContain('User-agent: GPTBot\nDisallow: /');
    expect(body).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  });

  it('/sitemap.xml：静态路径 + 活动详情 + 推文', async () => {
    const { status, headers, body } = await get('/sitemap.xml');
    expect(status).toBe(200);
    expect(headers['content-type']).toContain('application/xml');
    expect(body).toContain(`<loc>${SITE_ORIGIN}/</loc>`);
    expect(body).toContain(`<loc>${SITE_ORIGIN}/about</loc>`);
    expect(body).toContain(`<loc>${SITE_ORIGIN}/a/act1</loc>`);
    expect(body).toContain(`<loc>${SITE_ORIGIN}/posts/post1</loc>`);
    expect(body).not.toContain('lastmod');
  });

  it('/public-assets 静态资源：hash 资源 immutable，og 图短缓存', async () => {
    const asset = await get('/public-assets/assets/entry-public-client-test.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.body).toContain('console.log(1)');

    const og = await get('/public-assets/og-share.jpg');
    expect(og.status).toBe(200);
    expect(og.headers['content-type']).toBe('image/jpeg');
    expect(og.headers['cache-control']).toBe('public, max-age=300');
  });

  it('/public-assets 防目录穿越与隐藏文件', async () => {
    expect((await get('/public-assets/.vite/manifest.json')).status).toBe(404);
    expect((await get('/public-assets/missing.js')).status).toBe(404);
    // URL 解析归一化后不再命中前缀 → 走 404 通用页
    expect((await get('/public-assets/../index.html')).status).toBe(404);
  });
});
