// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { matchPublicRoute, PUBLIC_STATIC_PATHS } from './routes';

/**
 * 公开路由匹配矩阵（public/routes.ts 为渲染/元信息/sitemap 的单一来源）。
 * 口径：静态路径精确匹配；动态段为单段 id（/^[A-Za-z0-9_-]{1,64}$/）；
 * 大小写敏感；尾斜杠不规范化（不匹配即 404）。
 */
describe('matchPublicRoute 静态路径', () => {
  it('五个静态路径精确命中', () => {
    expect(matchPublicRoute('/')?.id).toBe('home');
    expect(matchPublicRoute('/about')?.id).toBe('about');
    expect(matchPublicRoute('/privacy')?.id).toBe('privacy');
    expect(matchPublicRoute('/activities')?.id).toBe('activities');
    expect(matchPublicRoute('/activities/past')?.id).toBe('past');
    expect(matchPublicRoute('/about')?.params).toEqual({});
    expect(matchPublicRoute('/about')?.pathname).toBe('/about');
  });

  it('尾斜杠不规范化：按未命中处理（服务端 404）', () => {
    expect(matchPublicRoute('/about/')).toBeNull();
    expect(matchPublicRoute('/activities/')).toBeNull();
    expect(matchPublicRoute('/activities/past/')).toBeNull();
  });

  it('大小写敏感：/About 不匹配', () => {
    expect(matchPublicRoute('/About')).toBeNull();
    expect(matchPublicRoute('/ABOUT')).toBeNull();
  });
});

describe('matchPublicRoute 动态路径', () => {
  it('/a/:id 与 /posts/:id 单段 id 命中', () => {
    expect(matchPublicRoute('/a/abc123')).toEqual({
      id: 'activity',
      params: { id: 'abc123' },
      pathname: '/a/abc123',
    });
    expect(matchPublicRoute('/posts/post-1_x')).toEqual({
      id: 'post',
      params: { id: 'post-1_x' },
      pathname: '/posts/post-1_x',
    });
  });

  it('id 形态校验：只允许字母数字下划线连字符，1–64 位', () => {
    expect(matchPublicRoute('/a/ABC_def-123')).not.toBeNull();
    expect(matchPublicRoute('/a/')).toBeNull();
    expect(matchPublicRoute('/a/has.dot')).toBeNull();
    expect(matchPublicRoute('/a/has%20space')).toBeNull();
    expect(matchPublicRoute(`/a/${'x'.repeat(64)}`)).not.toBeNull();
    expect(matchPublicRoute(`/a/${'x'.repeat(65)}`)).toBeNull();
  });

  it('功能子路由与多级路径不匹配', () => {
    expect(matchPublicRoute('/a/x/register')).toBeNull();
    expect(matchPublicRoute('/a/x/y')).toBeNull();
    expect(matchPublicRoute('/posts/x/y')).toBeNull();
  });

  it('功能页与未知路径不匹配', () => {
    for (const path of [
      '/login',
      '/me',
      '/trainings',
      '/checkin/tok',
      '/survey/qr',
      '/training-checkin/tok',
      '/admin',
      '/admin/login',
      '/super/dashboard',
      '/api/health',
      '/robots.txt',
      '/nonexistent',
    ]) {
      expect(matchPublicRoute(path)).toBeNull();
    }
  });
});

describe('PUBLIC_STATIC_PATHS', () => {
  it('与路由表一致', () => {
    expect([...PUBLIC_STATIC_PATHS]).toEqual([
      '/',
      '/about',
      '/privacy',
      '/activities',
      '/activities/past',
    ]);
  });
});
