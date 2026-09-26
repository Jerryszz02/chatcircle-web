// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { OG_IMAGE_PATH, renderNotFoundBody, renderPublicBody } from '../entry-public-server';
import { matchPublicRoute, PUBLIC_STATIC_PATHS } from './routes';
import type { PublicPageData } from './types';

/**
 * 服务端渲染纯净性测试（node 环境，无 window/document）：
 * import 链路不抛错即证明模块图无浏览器全局依赖；
 * 逐路由渲染断言关键内容与白名单字段（registration_fields/created_by 不出现）。
 */

const GENERATED_AT = '2026-09-26T00:00:00.000Z';

const ACTIVITY = {
  id: 'act1',
  title: '八月光影茶话会',
  activity_code: 'CC_SG_202608_01',
  description: '一场关于光影与倾诉的聚会。',
  location: '三楼活动室',
  // 未结束场次（晚于 generatedAt），会出现在首页/现有活动列表
  start_time: '2026-10-10 02:00:00.000Z',
  end_time: '2026-10-10 04:00:00.000Z',
  status: 'published' as const,
  capacity_total: 20,
  registration: { open: true, reason: null, remaining_total: 5 },
};

const POST = {
  id: 'post1',
  title: '首场活动回顾',
  summary: '后台上传的活动回顾摘要。',
  cover: 'cover.png',
  body_md: '# 正文标题',
  external_url: 'https://example.com/post1',
  is_pinned: false,
  published_at: '2026-08-01 00:00:00.000Z',
};

function render(pathname: string, data: PublicPageData): string {
  const match = matchPublicRoute(pathname);
  if (!match) throw new Error(`测试路径未命中公开路由：${pathname}`);
  return renderPublicBody(match, data);
}

describe('公开页 SSR 纯净性（node 环境渲染不抛错）', () => {
  it('首页：Hero + 现有活动 + 往期推文', () => {
    const html = render('/', {
      kind: 'home',
      generatedAt: GENERATED_AT,
      activities: [ACTIVITY],
      activitiesError: null,
      posts: [POST],
      postsError: null,
    });
    expect(html).toContain('被真正听见');
    expect(html).toContain('八月光影茶话会');
    expect(html).toContain('首场活动回顾');
    // 登录占位为纯链接（SSR 不含会话内容）
    expect(html).toContain('href="/login"');
  });

  it('现有活动页：匿名问卷指引态 + 活动卡片', () => {
    const html = render('/activities', {
      kind: 'activities',
      generatedAt: GENERATED_AT,
      activities: [ACTIVITY],
      activitiesError: null,
    });
    expect(html).toContain('现有活动');
    expect(html).toContain('八月光影茶话会');
    expect(html).toContain('问卷通过活动现场的二维码进入');
    expect(html).toContain('登录查看我的问卷');
  });

  it('往期活动页：推文卡片（封面 URL 为 /api/files 相对路径）', () => {
    const html = render('/activities/past', {
      kind: 'past',
      generatedAt: GENERATED_AT,
      posts: [POST],
      postsError: null,
    });
    expect(html).toContain('往期活动');
    expect(html).toContain('/api/files/posts/post1/cover.png');
  });

  it('活动详情：报名开放口径 + 不含 registration_fields', () => {
    const html = render('/a/act1', {
      kind: 'activity',
      generatedAt: GENERATED_AT,
      detail: {
        activity: { ...ACTIVITY, capacity_speaker: 10, capacity_listener: 10 },
        registration: {
          open: true,
          reason: null,
          remaining_total: 5,
          remaining_speaker: 2,
          remaining_listener: 3,
        },
      },
    });
    expect(html).toContain('八月光影茶话会');
    expect(html).toContain('总名额剩余 5 个');
    expect(html).toContain('href="/a/act1/register"');
    expect(html).not.toContain('registration_fields');
    // 会话敏感区不进 SSR
    expect(html).not.toContain('我的现场编号');
  });

  it('文章页：Markdown 渲染 + skipHtml 不执行内联 HTML', () => {
    const html = render('/posts/post1', {
      kind: 'post',
      generatedAt: GENERATED_AT,
      post: { ...POST, body_md: '# 正文标题\n\n<script>alert(1)</script>' },
    });
    expect(html).toContain('首场活动回顾');
    expect(html).toContain('正文标题');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('about/privacy 纯静态页渲染', () => {
    expect(render('/about', { kind: 'about', generatedAt: GENERATED_AT })).toContain(
      '关于 Chat Circles',
    );
    expect(render('/privacy', { kind: 'privacy', generatedAt: GENERATED_AT })).toContain(
      'Chat Circles 隐私政策',
    );
  });

  it('静态路径与渲染覆盖一一对应', () => {
    expect(PUBLIC_STATIC_PATHS).toHaveLength(5);
  });

  it('404 通用页：文案 + 返回首页/浏览活动链接', () => {
    const html = renderNotFoundBody('内容不存在或已下线', '/nonexistent');
    expect(html).toContain('内容不存在或已下线');
    expect(html).toContain('返回首页');
    expect(html).toContain('浏览活动');
  });

  it('OG 图固定路径常量', () => {
    expect(OG_IMAGE_PATH).toBe('/public-assets/og-share.jpg');
  });
});
