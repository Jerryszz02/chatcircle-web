import type { PublicPageData, PublicPostView } from './types';
import type { PublicRouteMatch } from './routes';

/**
 * 公开页元信息构建（title/description/canonical/robots/OG/JSON-LD）。
 *
 * 原则：所有文案来自页面真实内容或后端数据（截取 ≤160 字），不编造事实；
 * JSON-LD 宁缺毋滥——事实不足时降级 WebPage，Event 不填 eventStatus/offers，
 * Article 不编造 author（仅有运营方 Organization 作为 publisher）。
 */

export interface PageMetadata {
  title: string;
  description: string;
  /** 规范链接：siteOrigin + 干净路径（不含 query/hash）。 */
  canonical: string;
  robots: string;
  og: {
    title: string;
    description: string;
    url: string;
    type: 'website' | 'article';
    site_name: string;
    locale: string;
    image?: string;
  };
  jsonLd: Record<string, unknown>[];
}

export interface MetadataOptions {
  siteOrigin: string;
  /** og:image 绝对地址（缺省不加 image）。 */
  ogImageUrl?: string;
}

const SITE_NAME = 'Chat Circles';
const DESCRIPTION_MAX = 160;

/** 页面真实文案截取为 description（压缩空白，≤160 字）。 */
function excerpt(text: string, max = DESCRIPTION_MAX): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

/** 运营方 Organization（与 SiteFooter 公开信息一致，不虚构法人/联系方式）。 */
function organizationJsonLd(siteOrigin: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Empact',
    legalName: '上海井畅企业管理咨询有限公司',
    url: 'https://empact.cn/',
    email: 'maggie.yang@empact.sg',
    address: {
      '@type': 'PostalAddress',
      addressCountry: 'CN',
      addressLocality: '上海市',
      streetAddress: '虹漕路88号越虹广场B座1609',
    },
    // Chat Circles 项目主页
    sameAs: [siteOrigin],
  };
}

/** PocketBase 日期（'YYYY-MM-DD HH:mm:ss.sssZ'）转 ISO 8601；非法返回 null。 */
function pbDateToIso(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function breadcrumb(items: { name: string; path: string }[], siteOrigin: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: `${siteOrigin}${item.path}`,
    })),
  };
}

function postDescription(post: PublicPostView): string {
  const text = post.summary?.trim() || post.body_md?.trim() || '';
  return text ? excerpt(text) : `${post.title} · Chat Circles 往期活动回顾`;
}

/** 构建公开页元信息。robots 默认 index,follow（404 页由调用方另行指定 noindex）。 */
export function buildMetadata(
  match: PublicRouteMatch,
  data: PublicPageData | null,
  options: MetadataOptions,
): PageMetadata {
  const siteOrigin = options.siteOrigin.replace(/\/+$/, '');
  const canonical = `${siteOrigin}${match.pathname}`;
  const organization = organizationJsonLd(siteOrigin);

  let title: string;
  let description: string;
  let ogType: 'website' | 'article' = 'website';
  let jsonLd: Record<string, unknown>[];

  switch (match.id) {
    case 'home': {
      title = 'Chat Circles · 青年心理健康公益项目';
      description = excerpt(
        'Chat Circles 把经过 3 小时专业培训的志愿者「倾听者」，与正处于升学、初入职场等过渡期的青年一对一配对——在轻松的空间里进行一场 60 分钟的结构化对话：没有评判，没有说教，只有真正的倾听。',
      );
      jsonLd = [
        {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: SITE_NAME,
          url: siteOrigin,
          inLanguage: 'zh-CN',
        },
        organization,
      ];
      break;
    }
    case 'about': {
      title = '关于我们 · Chat Circles';
      description = excerpt(
        '一个青年心理健康公益项目：把「想说说不出」的青年，和「愿意认真听」的志愿者，带到同一张桌子前。',
      );
      jsonLd = [
        {
          '@context': 'https://schema.org',
          '@type': 'AboutPage',
          name: title,
          description,
          url: canonical,
          inLanguage: 'zh-CN',
          isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: siteOrigin },
        },
      ];
      break;
    }
    case 'privacy': {
      title = '隐私政策 · Chat Circles';
      description = excerpt(
        '上海井畅企业管理咨询有限公司负责 Chat Circles 网站中的个人信息处理。我们通过平台组织青年公益倾听活动，尊重你的隐私。本政策说明我们处理哪些信息、用途、保存时间，以及你如何联系我们。',
      );
      jsonLd = [
        {
          '@context': 'https://schema.org',
          '@type': 'WebPage',
          name: title,
          description,
          url: canonical,
          inLanguage: 'zh-CN',
          isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: siteOrigin },
        },
      ];
      break;
    }
    case 'activities': {
      title = '现有活动 · Chat Circles';
      description = excerpt(
        'Chat Circles 现有活动：浏览进行中的活动并报名。问卷通过活动现场的二维码进入；填写问卷需要登录参与者账号。',
      );
      jsonLd = [
        {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: title,
          description,
          url: canonical,
          inLanguage: 'zh-CN',
          isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: siteOrigin },
        },
      ];
      break;
    }
    case 'past': {
      title = '往期活动 · Chat Circles';
      const posts = data?.kind === 'past' ? data.posts : null;
      description =
        posts && posts.length > 0
          ? postDescription(posts[0])
          : 'Chat Circles 青年心理健康公益项目的往期活动回顾与公开推文。';
      jsonLd = [
        {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: title,
          description,
          url: canonical,
          inLanguage: 'zh-CN',
          isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: siteOrigin },
        },
      ];
      break;
    }
    case 'activity': {
      const detail = data?.kind === 'activity' ? data.detail : null;
      const activityTitle = detail?.activity.title ?? '活动详情';
      title = `${activityTitle} · Chat Circles`;
      description = detail?.activity.description?.trim()
        ? excerpt(detail.activity.description)
        : `${activityTitle} · Chat Circles 公开活动`;
      const startDate = pbDateToIso(detail?.activity.start_time);
      const endDate = pbDateToIso(detail?.activity.end_time);
      // 事实充分（有标题 + 开始时间）才标 Event；否则降级 WebPage，不编造
      const pageJsonLd: Record<string, unknown> =
        detail && startDate
          ? {
              '@context': 'https://schema.org',
              '@type': 'Event',
              name: activityTitle,
              startDate,
              ...(endDate ? { endDate } : {}),
              ...(detail.activity.location
                ? { location: { '@type': 'Place', name: detail.activity.location } }
                : {}),
              organizer: organization,
              url: canonical,
              description,
              inLanguage: 'zh-CN',
            }
          : {
              '@context': 'https://schema.org',
              '@type': 'WebPage',
              name: title,
              description,
              url: canonical,
              inLanguage: 'zh-CN',
            };
      jsonLd = [
        pageJsonLd,
        breadcrumb(
          [
            { name: '首页', path: '/' },
            { name: '现有活动', path: '/activities' },
            { name: activityTitle, path: match.pathname },
          ],
          siteOrigin,
        ),
      ];
      break;
    }
    case 'post': {
      const post = data?.kind === 'post' ? data.post : null;
      const postTitle = post?.title ?? '文章';
      title = `${postTitle} · Chat Circles`;
      description = post ? postDescription(post) : 'Chat Circles 往期活动回顾';
      ogType = 'article';
      const datePublished = pbDateToIso(post?.published_at);
      jsonLd = [
        {
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: postTitle,
          ...(datePublished ? { datePublished } : {}),
          publisher: organization,
          mainEntityOfPage: canonical,
          description,
          inLanguage: 'zh-CN',
        },
        breadcrumb(
          [
            { name: '首页', path: '/' },
            { name: '往期活动', path: '/activities/past' },
            { name: postTitle, path: match.pathname },
          ],
          siteOrigin,
        ),
      ];
      break;
    }
  }

  return {
    title,
    description,
    canonical,
    robots: 'index,follow',
    og: {
      title,
      description,
      url: canonical,
      type: ogType,
      site_name: SITE_NAME,
      locale: 'zh_CN',
      ...(options.ogImageUrl ? { image: options.ogImageUrl } : {}),
    },
    jsonLd,
  };
}
