// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildMetadata } from './metadata';
import { matchPublicRoute } from './routes';
import type { PublicPageData } from './types';

/**
 * 元信息构建单测：title 唯一性、canonical 口径、JSON-LD 类型与字段边界
 * （Event 不填 eventStatus/offers，Article 不编造 author，事实不足降级 WebPage）。
 */

const OPTIONS = {
  siteOrigin: 'https://chatcircle.empact.cn',
  ogImageUrl: 'https://chatcircle.empact.cn/public-assets/og-share.jpg',
};

const GENERATED_AT = '2026-09-26T00:00:00.000Z';

function activityData(overrides: Record<string, unknown> = {}): PublicPageData {
  return {
    kind: 'activity',
    generatedAt: GENERATED_AT,
    detail: {
      activity: {
        id: 'act1',
        title: '八月光影茶话会',
        activity_code: 'CC_SG_202608_01',
        description: '一场关于光影与倾诉的聚会。',
        location: '三楼活动室',
        start_time: '2026-08-10 02:00:00.000Z',
        end_time: '2026-08-10 04:00:00.000Z',
        status: 'published',
        capacity_total: 20,
        ...overrides,
      },
      registration: { open: true, reason: null, remaining_total: 5 },
    },
  } as PublicPageData;
}

function postData(overrides: Record<string, unknown> = {}): PublicPageData {
  return {
    kind: 'post',
    generatedAt: GENERATED_AT,
    post: {
      id: 'post1',
      title: '首场活动回顾',
      summary: '后台上传的活动回顾摘要。',
      is_pinned: false,
      published_at: '2026-08-01 00:00:00.000Z',
      ...overrides,
    },
  };
}

function jsonLdTypes(meta: { jsonLd: Record<string, unknown>[] }): string[] {
  return meta.jsonLd.map((item) => String(item['@type']));
}

describe('buildMetadata 通用口径', () => {
  it('各路由 title 唯一', () => {
    const titles = [
      buildMetadata(
        matchPublicRoute('/')!,
        {
          kind: 'home',
          generatedAt: GENERATED_AT,
          activities: [],
          activitiesError: null,
          posts: [],
          postsError: null,
        },
        OPTIONS,
      ).title,
      buildMetadata(
        matchPublicRoute('/about')!,
        { kind: 'about', generatedAt: GENERATED_AT },
        OPTIONS,
      ).title,
      buildMetadata(
        matchPublicRoute('/privacy')!,
        { kind: 'privacy', generatedAt: GENERATED_AT },
        OPTIONS,
      ).title,
      buildMetadata(
        matchPublicRoute('/activities')!,
        { kind: 'activities', generatedAt: GENERATED_AT, activities: [], activitiesError: null },
        OPTIONS,
      ).title,
      buildMetadata(
        matchPublicRoute('/activities/past')!,
        { kind: 'past', generatedAt: GENERATED_AT, posts: [], postsError: null },
        OPTIONS,
      ).title,
      buildMetadata(matchPublicRoute('/a/act1')!, activityData(), OPTIONS).title,
      buildMetadata(matchPublicRoute('/posts/post1')!, postData(), OPTIONS).title,
    ];
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('canonical = siteOrigin + 干净路径；robots 默认 index,follow；OG 完整', () => {
    const meta = buildMetadata(matchPublicRoute('/a/act1')!, activityData(), OPTIONS);
    expect(meta.canonical).toBe('https://chatcircle.empact.cn/a/act1');
    expect(meta.canonical).not.toContain('?');
    expect(meta.robots).toBe('index,follow');
    expect(meta.og).toEqual({
      title: meta.title,
      description: meta.description,
      url: meta.canonical,
      type: 'website',
      site_name: 'Chat Circles',
      locale: 'zh_CN',
      image: 'https://chatcircle.empact.cn/public-assets/og-share.jpg',
    });
  });

  it('siteOrigin 尾斜杠归一化', () => {
    const meta = buildMetadata(matchPublicRoute('/about')!, null, {
      ...OPTIONS,
      siteOrigin: 'https://chatcircle.empact.cn/',
    });
    expect(meta.canonical).toBe('https://chatcircle.empact.cn/about');
  });

  it('description 来自真实文案且 ≤160 字', () => {
    const longDescription = '这是一场活动。'.repeat(50);
    const meta = buildMetadata(
      matchPublicRoute('/a/act1')!,
      activityData({ description: longDescription }),
      OPTIONS,
    );
    expect(meta.description.length).toBeLessThanOrEqual(160);
    expect(meta.description).toContain('这是一场活动。');
  });
});

describe('buildMetadata JSON-LD', () => {
  it('home：WebSite + Organization（Empact/上海井畅，不虚构法人）', () => {
    const meta = buildMetadata(
      matchPublicRoute('/')!,
      {
        kind: 'home',
        generatedAt: GENERATED_AT,
        activities: [],
        activitiesError: null,
        posts: [],
        postsError: null,
      },
      OPTIONS,
    );
    expect(meta.title).toBe('Chat Circles · 青年心理健康公益项目');
    expect(jsonLdTypes(meta)).toEqual(['WebSite', 'Organization']);
    const org = meta.jsonLd[1];
    expect(org.legalName).toBe('上海井畅企业管理咨询有限公司');
    expect(org.name).toBe('Empact');
  });

  it('about/privacy/activities/past：AboutPage/WebPage/CollectionPage', () => {
    expect(
      jsonLdTypes(
        buildMetadata(
          matchPublicRoute('/about')!,
          { kind: 'about', generatedAt: GENERATED_AT },
          OPTIONS,
        ),
      ),
    ).toEqual(['AboutPage']);
    expect(
      jsonLdTypes(
        buildMetadata(
          matchPublicRoute('/privacy')!,
          { kind: 'privacy', generatedAt: GENERATED_AT },
          OPTIONS,
        ),
      ),
    ).toEqual(['WebPage']);
    expect(
      jsonLdTypes(
        buildMetadata(
          matchPublicRoute('/activities')!,
          { kind: 'activities', generatedAt: GENERATED_AT, activities: [], activitiesError: null },
          OPTIONS,
        ),
      ),
    ).toEqual(['CollectionPage']);
    expect(
      jsonLdTypes(
        buildMetadata(
          matchPublicRoute('/activities/past')!,
          { kind: 'past', generatedAt: GENERATED_AT, posts: [], postsError: null },
          OPTIONS,
        ),
      ),
    ).toEqual(['CollectionPage']);
  });

  it('活动详情事实充分 → Event（无 eventStatus/offers），附 BreadcrumbList', () => {
    const meta = buildMetadata(matchPublicRoute('/a/act1')!, activityData(), OPTIONS);
    expect(jsonLdTypes(meta)).toEqual(['Event', 'BreadcrumbList']);
    const event = meta.jsonLd[0];
    expect(event.name).toBe('八月光影茶话会');
    expect(event.startDate).toBe('2026-08-10T02:00:00.000Z');
    expect(event.endDate).toBe('2026-08-10T04:00:00.000Z');
    expect(event.location).toEqual({ '@type': 'Place', name: '三楼活动室' });
    expect(event.organizer).toMatchObject({
      '@type': 'Organization',
      legalName: '上海井畅企业管理咨询有限公司',
    });
    expect(event.url).toBe('https://chatcircle.empact.cn/a/act1');
    expect(event).not.toHaveProperty('eventStatus');
    expect(event).not.toHaveProperty('offers');
  });

  it('活动缺 start_time（不可解析）→ 降级 WebPage', () => {
    const meta = buildMetadata(
      matchPublicRoute('/a/act1')!,
      activityData({ start_time: 'not-a-date' }),
      OPTIONS,
    );
    expect(jsonLdTypes(meta)).toEqual(['WebPage', 'BreadcrumbList']);
  });

  it('文章 → Article（无 author；有 published_at 才填 datePublished），附 BreadcrumbList', () => {
    const meta = buildMetadata(matchPublicRoute('/posts/post1')!, postData(), OPTIONS);
    expect(jsonLdTypes(meta)).toEqual(['Article', 'BreadcrumbList']);
    const article = meta.jsonLd[0];
    expect(article.headline).toBe('首场活动回顾');
    expect(article.datePublished).toBe('2026-08-01T00:00:00.000Z');
    expect(article.publisher).toMatchObject({ '@type': 'Organization' });
    expect(article).not.toHaveProperty('author');
    expect(meta.og.type).toBe('article');
  });

  it('文章无 published_at → 不填 datePublished', () => {
    const meta = buildMetadata(
      matchPublicRoute('/posts/post1')!,
      postData({ published_at: undefined }),
      OPTIONS,
    );
    expect(meta.jsonLd[0]).not.toHaveProperty('datePublished');
  });
});
