import type { ReactNode } from 'react';
import type { PublicLoadError, PublicPostView } from '../../../public/types';
import { Button, Loading } from '../../../shared/ui';
import { PublicPageLayout } from '../components/PublicPageLayout';
import { PublicPostCard } from '../components/PublicPostCard';

/**
 * 往期活动页纯展示视图（SSR 安全）：后台 visible 推文的完整列表。
 * 数据直读 posts 集合（服务端 rule 过滤 hidden）；置顶优先，再按发布时间倒序。
 */
export function PastActivitiesPageView({
  posts,
  postsError,
  onRetryPosts,
  actions,
}: {
  posts: PublicPostView[] | null;
  postsError: PublicLoadError | null;
  onRetryPosts?: () => void;
  /** 站点头部账号区插槽。 */
  actions?: ReactNode;
}) {
  return (
    <PublicPageLayout actions={actions}>
      <section>
        <h2 className="ccp-section-title">往期活动</h2>
        {posts === null && !postsError ? <Loading /> : null}

        {postsError ? (
          <>
            <p className="cc-empty">{postsError.message}</p>
            <Button variant="secondary" onClick={onRetryPosts}>
              重试
            </Button>
          </>
        ) : null}

        {posts !== null && posts.length === 0 ? (
          <div className="ccp-empty">
            <span className="ccp-empty-chip" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
            </span>
            <p className="cc-empty">暂无往期活动。</p>
          </div>
        ) : null}

        {posts && posts.length > 0 ? (
          <ul className="ccp-card-grid">
            {posts.map((post) => (
              <PublicPostCard key={post.id} post={post} />
            ))}
          </ul>
        ) : null}
      </section>
    </PublicPageLayout>
  );
}
