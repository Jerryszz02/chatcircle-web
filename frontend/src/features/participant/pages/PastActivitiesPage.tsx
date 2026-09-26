import { useEffect, useState } from 'react';
import { normalizeApiError } from '../../../shared/api/http';
import type { PostRecord } from '../../../shared/api/types';
import { toPublicLoadError } from '../../../public/loadError';
import type { PublicLoadError } from '../../../public/types';
import { getPublicPosts } from '../api';
import { AccountActions } from '../components/AccountActions';
import { PastActivitiesPageView } from './PastActivitiesPageView';

/**
 * 往期活动页容器（/activities/past，未登录可看）：hook 取数后渲染 PastActivitiesPageView。
 * SSR 版本由 server/ 渲染同一 View。
 */
export function PastActivitiesPage() {
  const [posts, setPosts] = useState<PostRecord[] | null>(null);
  const [postsError, setPostsError] = useState<PublicLoadError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getPublicPosts()
      .then((items) => {
        if (cancelled) return;
        setPosts(items);
        // 重试成功后清除此前的错误提示与重试按钮
        setPostsError(null);
      })
      .catch((err) => {
        if (!cancelled) setPostsError(toPublicLoadError(normalizeApiError(err)));
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return (
    <PastActivitiesPageView
      posts={posts}
      postsError={postsError}
      onRetryPosts={() => setTick((t) => t + 1)}
      actions={<AccountActions />}
    />
  );
}
