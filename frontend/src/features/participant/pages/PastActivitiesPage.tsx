import { useEffect, useState } from 'react';
import { normalizeApiError, type ApiError } from '../../../shared/api/http';
import type { PostRecord } from '../../../shared/api/types';
import { Button, Loading } from '../../../shared/ui';
import { getPublicPosts } from '../api';
import { PublicPostCard } from '../components/PublicPostCard';
import { PublicPageLayout } from '../components/PublicPageLayout';

/**
 * 往期活动页（/activities/past，未登录可看）：后台 visible 推文的完整列表。
 * 数据直读 posts 集合，服务端 rule 过滤 hidden；置顶优先，再按发布时间倒序。
 */
export function PastActivitiesPage() {
  const [posts, setPosts] = useState<PostRecord[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getPublicPosts()
      .then((items) => {
        if (cancelled) return;
        setPosts(items);
        // 重试成功后清除此前的错误提示与重试按钮
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(normalizeApiError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return (
    <PublicPageLayout>
      <section>
        <h2 className="ccp-section-title">往期活动</h2>
        {posts === null && !error ? <Loading /> : null}

        {error ? (
          <>
            <p className="cc-empty">{error.message}</p>
            <Button variant="secondary" onClick={() => setTick((t) => t + 1)}>
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
