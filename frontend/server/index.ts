import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OG_IMAGE_PATH, renderNotFoundBody, renderPublicBody } from '../src/entry-public-server';
import {
  createPublicDataClient,
  PublicNotFoundError,
  type PublicDataClient,
} from '../src/public/data';
import { buildMetadata, type PageMetadata } from '../src/public/metadata';
import { matchPublicRoute, PUBLIC_STATIC_PATHS } from '../src/public/routes';
import type { PublicLoadError, PublicPageData } from '../src/public/types';
import { loadPublicServerConfig } from './config';
import { escapeHtml, loadClientAssets, renderDocument, type ClientAssets } from './html';

/**
 * 公开页渲染服务（node:http，无框架依赖）：公开页 SSR + 静态资源 + robots/sitemap。
 *
 * 路由顺序：/healthz → /readyz → /public-assets/* → /robots.txt → /sitemap.xml →
 * 公开路由（matchPublicRoute）→ 404 通用页。
 * 错误口径：PublicNotFoundError → 404 通用页（不泄露草稿/隐藏内容存在性）；
 * 上游故障/超时 → 503 + Retry-After: 30（首页例外：静态介绍仍在时 200，列表区传错误态）。
 * 所有动态响应 Cache-Control: no-store；日志只写 JSON 行 {method, pathname, status, ms}。
 */

export interface PublicServerOptions {
  siteOrigin: string;
  pbBaseUrl: string;
  fetchTimeoutMs: number;
  maxInflight: number;
  /** dist-public/client 目录（含 .vite/manifest.json）。 */
  clientDir: string;
  /** 访问日志输出（JSON 行）；默认 console.log。 */
  logger?: (line: string) => void;
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const RETRY_AFTER_SECONDS = '30';

/** 上游错误 → 视图错误态（用户可见文案，不含内部细节）。 */
function upstreamLoadError(err: unknown): PublicLoadError {
  const status =
    err instanceof Error && 'status' in err && typeof err.status === 'number' && err.status > 0
      ? err.status
      : 503;
  return { status, message: '内容暂时无法加载，请稍后重试。' };
}

export function createPublicServer(options: PublicServerOptions): Server {
  const siteOrigin = options.siteOrigin.replace(/\/+$/, '');
  const ogImageUrl = `${siteOrigin}${OG_IMAGE_PATH}`;
  const assets: ClientAssets = loadClientAssets(options.clientDir);
  const dataClient: PublicDataClient = createPublicDataClient({
    pbBaseUrl: options.pbBaseUrl,
    timeoutMs: options.fetchTimeoutMs,
    maxInflight: options.maxInflight,
  });
  const log = options.logger ?? ((line: string) => console.log(line));

  /** 发送响应（HEAD 只回头部）；返回最终 status 供日志记录。 */
  function send(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    contentType: string,
    body: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    res.writeHead(status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      ...extraHeaders,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function sendHtml(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    html: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    send(req, res, status, 'text/html; charset=utf-8', html, extraHeaders);
  }

  function notFoundMetadata(pathname: string): PageMetadata {
    const title = '页面不存在 · Chat Circles';
    const description = '内容不存在或已下线';
    return {
      title,
      description,
      canonical: `${siteOrigin}${pathname}`,
      robots: 'noindex',
      og: {
        title,
        description,
        url: `${siteOrigin}${pathname}`,
        type: 'website',
        site_name: 'Chat Circles',
        locale: 'zh_CN',
      },
      jsonLd: [],
    };
  }

  /** 404 通用页（未匹配路径与内容不存在同口径）。 */
  function sendNotFound(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    const body = renderNotFoundBody('内容不存在或已下线', pathname);
    sendHtml(
      req,
      res,
      404,
      renderDocument({
        metadata: notFoundMetadata(pathname),
        bodyHtml: body,
        data: null,
        assets,
      }),
    );
  }

  /** 503 页（上游故障/超时；Retry-After 提示抓取方稍后重试）。 */
  function sendUnavailable(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    const title = '服务暂时不可用 · Chat Circles';
    const description = '服务暂时不可用，请稍后重试。';
    const body = renderNotFoundBody('服务暂时不可用，请稍后重试。', pathname);
    sendHtml(
      req,
      res,
      503,
      renderDocument({
        metadata: {
          ...notFoundMetadata(pathname),
          title,
          description,
          og: { ...notFoundMetadata(pathname).og, title, description },
        },
        bodyHtml: body,
        data: null,
        assets,
      }),
      { 'retry-after': RETRY_AFTER_SECONDS },
    );
  }

  async function handleReady(res: ServerResponse): Promise<void> {
    try {
      const upstream = await fetch(`${options.pbBaseUrl}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      res.writeHead(upstream.ok ? 200 : 503, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(upstream.ok ? 'ok' : 'upstream unavailable');
    } catch {
      res.writeHead(503, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end('upstream unavailable');
    }
  }

  async function handleAsset(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    // 防目录穿越：URL 解析已归一化 dot 段，此处再逐段校验，
    // 拒绝 '..' 与 '.' 开头段（顺带屏蔽 .vite/manifest.json）
    const rel = pathname.slice('/public-assets/'.length);
    const segments = rel.split('/').filter(Boolean);
    const invalid =
      segments.length === 0 ||
      segments.some((segment) => segment === '..' || segment.startsWith('.'));
    if (invalid) {
      send(req, res, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    const filePath = join(options.clientDir, ...segments);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      send(req, res, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    if (!fileStat.isFile()) {
      send(req, res, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    // vite 产物带内容 hash（assets/ 目录）→ immutable；og-share.jpg 等固定名 → 短缓存
    const cacheControl =
      segments[0] === 'assets' ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'content-length': fileStat.size,
      'cache-control': cacheControl,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await new Promise<void>((resolve) => {
      createReadStream(filePath).pipe(res).on('finish', resolve);
    });
  }

  function handleRobots(req: IncomingMessage, res: ServerResponse): void {
    // 训练数据退出（GPTBot）与内容许可分离；OAI-SearchBot 不另设限制（沿用 * 组）。
    const text = [
      'User-agent: *',
      'Disallow: /login',
      'Disallow: /me',
      'Disallow: /trainings',
      'Disallow: /checkin/',
      'Disallow: /training-checkin/',
      'Disallow: /survey/',
      'Disallow: /admin',
      'Disallow: /super',
      'Disallow: /api/',
      'Disallow: /_/',
      'Disallow: /a/*/register',
      '',
      'User-agent: GPTBot',
      'Disallow: /',
      '',
      `Sitemap: ${siteOrigin}/sitemap.xml`,
      '',
    ].join('\n');
    send(req, res, 200, 'text/plain; charset=utf-8', text);
  }

  /** sitemap：仅当前可公开且会返回 200 的 URL；上游失败 → 503（绝不返回空 sitemap 伪装成功）。 */
  async function handleSitemap(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [current, past, postsResult] = await Promise.all([
      dataClient.fetchPublicActivities('current'),
      dataClient.fetchPublicActivities('past'),
      dataClient.fetchAllPublicPostIdsForSitemap(),
    ]);
    if (postsResult.truncated) {
      log(JSON.stringify({ level: 'warn', msg: 'sitemap 推文枚举达到硬上限，已截断' }));
    }
    const urls = [
      ...new Set([
        ...PUBLIC_STATIC_PATHS,
        ...current.map((a) => `/a/${a.id}`),
        ...past.map((a) => `/a/${a.id}`),
        ...postsResult.ids.map((id) => `/posts/${id}`),
      ]),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((path) => `  <url><loc>${escapeHtml(`${siteOrigin}${path}`)}</loc></url>`)
      .join('\n')}\n</urlset>\n`;
    send(req, res, 200, 'application/xml; charset=utf-8', xml);
  }

  /** 组装首帧数据并渲染 200 公开页。 */
  async function handlePublicPage(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const match = matchPublicRoute(pathname);
    if (!match) {
      sendNotFound(req, res, pathname);
      return;
    }
    const generatedAt = new Date().toISOString();
    let data: PublicPageData;
    switch (match.id) {
      case 'home': {
        // 首页韧性：静态介绍始终可渲染，列表区独立降级为错误态（不整页 503）
        const [activities, posts] = await Promise.allSettled([
          dataClient.fetchPublicActivities('current'),
          dataClient.fetchPublicPosts(2),
        ]);
        data = {
          kind: 'home',
          generatedAt,
          activities: activities.status === 'fulfilled' ? activities.value : null,
          activitiesError:
            activities.status === 'rejected' ? upstreamLoadError(activities.reason) : null,
          posts: posts.status === 'fulfilled' ? posts.value : null,
          postsError: posts.status === 'rejected' ? upstreamLoadError(posts.reason) : null,
        };
        break;
      }
      case 'about':
        data = { kind: 'about', generatedAt };
        break;
      case 'privacy':
        data = { kind: 'privacy', generatedAt };
        break;
      case 'activities':
        data = {
          kind: 'activities',
          generatedAt,
          activities: await dataClient.fetchPublicActivities('current'),
          activitiesError: null,
        };
        break;
      case 'past':
        data = {
          kind: 'past',
          generatedAt,
          posts: await dataClient.fetchPublicPosts(),
          postsError: null,
        };
        break;
      case 'activity':
        data = {
          kind: 'activity',
          generatedAt,
          detail: await dataClient.fetchPublicActivity(match.params.id ?? ''),
        };
        break;
      case 'post':
        data = {
          kind: 'post',
          generatedAt,
          post: await dataClient.fetchPublicPost(match.params.id ?? ''),
        };
        break;
    }
    const metadata = buildMetadata(match, data, { siteOrigin, ogImageUrl });
    const bodyHtml = renderPublicBody(match, data);
    sendHtml(req, res, 200, renderDocument({ metadata, bodyHtml, data, assets }));
  }

  const server = createServer((req, res) => {
    const startedAt = performance.now();
    const url = new URL(req.url ?? '/', 'http://internal');
    const pathname = normalize(url.pathname).replace(/\\/g, '/');
    res.on('finish', () => {
      log(
        JSON.stringify({
          method: req.method,
          pathname,
          status: res.statusCode,
          ms: Math.round(performance.now() - startedAt),
        }),
      );
    });

    void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendNotFound(req, res, pathname);
        return;
      }
      if (pathname === '/healthz') {
        send(req, res, 200, 'text/plain; charset=utf-8', 'ok');
        return;
      }
      if (pathname === '/readyz') {
        await handleReady(res);
        return;
      }
      if (pathname.startsWith('/public-assets/')) {
        await handleAsset(req, res, pathname);
        return;
      }
      if (pathname === '/robots.txt') {
        handleRobots(req, res);
        return;
      }
      if (pathname === '/sitemap.xml') {
        try {
          await handleSitemap(req, res);
        } catch {
          sendUnavailable(req, res, pathname);
        }
        return;
      }
      try {
        await handlePublicPage(req, res, pathname);
      } catch (err) {
        if (err instanceof PublicNotFoundError) {
          sendNotFound(req, res, pathname);
        } else {
          sendUnavailable(req, res, pathname);
        }
      }
    })().catch(() => {
      // 兜底：任何未预期异常都不得让连接悬挂
      if (!res.headersSent) {
        sendUnavailable(req, res, pathname);
      } else {
        res.end();
      }
    });
  });

  return server;
}

/** 直接运行（node dist-public/server/index.js）时启动；被测试 import 时不监听。 */
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const config = loadPublicServerConfig();
  const clientDir = fileURLToPath(new URL('../client/', import.meta.url));
  const server = createPublicServer({
    siteOrigin: config.siteOrigin,
    pbBaseUrl: config.pbBaseUrl,
    fetchTimeoutMs: config.fetchTimeoutMs,
    maxInflight: config.maxInflight,
    clientDir,
  });
  server.listen(config.port, () => {
    console.log(
      JSON.stringify({
        msg: 'public server listening',
        port: config.port,
        siteOrigin: config.siteOrigin,
      }),
    );
  });
}
