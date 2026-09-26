import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import { NavAnchor } from '../../../public/nav';
import type { PublicLoadError, PublicPostView } from '../../../public/types';
import { Loading } from '../../../shared/ui';
import { PublicPageLayout } from '../components/PublicPageLayout';
import { formatDateTime } from '../lib/status';

/**
 * 公开推文全文纯展示视图（SSR 安全）。
 * Markdown skipHtml + img 降级为 alt 文本占位：不执行内联 HTML、不加载远程图片。
 */
export function PostPageView({
  post,
  error,
  actions,
}: {
  post: PublicPostView | null;
  error: PublicLoadError | null;
  /** 站点头部账号区插槽。 */
  actions?: ReactNode;
}) {
  return (
    <PublicPageLayout actions={actions}>
      <article className="ccp-reading">
        <NavAnchor href="/activities/past">返回往期活动</NavAnchor>
        {error ? (
          <p role="alert">文章不存在、已隐藏或暂时无法读取，请返回列表重试。</p>
        ) : !post ? (
          <Loading />
        ) : (
          <>
            <h1>{post.title}</h1>
            <p className="cc-item-meta">发布于 {formatDateTime(post.published_at)}</p>
            <Markdown skipHtml components={{ img: ({ alt }) => <span>{alt}</span> }}>
              {post.body_md || post.summary || ''}
            </Markdown>
            {post.external_url ? (
              <a href={post.external_url} target="_blank" rel="noreferrer">
                阅读原文
              </a>
            ) : null}
          </>
        )}
      </article>
    </PublicPageLayout>
  );
}
