/**
 * 公开页路由匹配（渲染、元信息、sitemap、测试的单一来源）。
 *
 * 口径（有意保持简单、可预测）：
 * - 静态路径精确匹配；'/a/:id' 与 '/posts/:id' 为单段动态 id；
 * - id 仅允许 /^[A-Za-z0-9_-]{1,64}$/（PocketBase id 形态），
 *   '/a/x/register'、'/a/x/y'、含 '.' 的 id 均不匹配；
 * - 大小写敏感（'/About' 不匹配），尾斜杠不做规范化（'/about/' 不匹配）；
 *   未命中的路径由服务端按 404 处理；
 * - 入参为纯 pathname（不含 query/hash，调用方负责剥离）。
 */

export type PublicRouteId =
  'home' | 'about' | 'privacy' | 'activities' | 'past' | 'activity' | 'post';

export interface PublicRouteMatch {
  id: PublicRouteId;
  /** 动态段参数：activity/post 路由含 { id }，其余为 {}。 */
  params: Record<string, string>;
  /** 命中的原始 pathname（用于 canonical 与 CurrentPathProvider）。 */
  pathname: string;
}

/** 公开静态路径（sitemap 固定条目）。 */
export const PUBLIC_STATIC_PATHS = [
  '/',
  '/about',
  '/privacy',
  '/activities',
  '/activities/past',
] as const;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function matchDynamic(pathname: string, prefix: string): PublicRouteMatch | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  // 单段 id：不允许再含 '/'（排除 /a/x/register 之类的功能子路由）
  if (rest === '' || rest.includes('/') || !ID_PATTERN.test(rest)) return null;
  return { id: prefix === '/a/' ? 'activity' : 'post', params: { id: rest }, pathname };
}

/** 匹配公开路由；未命中（功能页/未知路径/形态非法）返回 null。 */
export function matchPublicRoute(pathname: string): PublicRouteMatch | null {
  switch (pathname) {
    case '/':
      return { id: 'home', params: {}, pathname };
    case '/about':
      return { id: 'about', params: {}, pathname };
    case '/privacy':
      return { id: 'privacy', params: {}, pathname };
    case '/activities':
      return { id: 'activities', params: {}, pathname };
    case '/activities/past':
      return { id: 'past', params: {}, pathname };
    default:
      return matchDynamic(pathname, '/a/') ?? matchDynamic(pathname, '/posts/');
  }
}
