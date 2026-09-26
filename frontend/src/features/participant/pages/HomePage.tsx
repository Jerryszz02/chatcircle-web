import { useEffect, useState } from 'react';
import { normalizeApiError } from '../../../shared/api/http';
import type { PostRecord } from '../../../shared/api/types';
import { toPublicLoadError } from '../../../public/loadError';
import type { PublicLoadError } from '../../../public/types';
import { getPublicActivities, getPublicPosts, type PublicActivityListItem } from '../api';
import { AccountActions } from '../components/AccountActions';
import { HomePageView } from './HomePageView';

/**
 * 首页容器（/，未登录可看）：hook 取数后渲染 HomePageView（纯展示）。
 * 区块：Hero → 现有活动（公开活动 API 真实数据，最近 2 场 + 查看全部）→
 * 往期活动（后台公开推文，最近 2 篇 + 查看全部）→ 我们的影响。
 * 浏览活动不需要账号；报名活动在对应链路内完成手机号认证。
 * SSR 版本由 server/ 渲染同一 View（首帧数据经 __CC_PUBLIC_DATA__ 下发）。
 */
export function HomePage() {
  const [activities, setActivities] = useState<PublicActivityListItem[] | null>(null);
  const [activitiesError, setActivitiesError] = useState<PublicLoadError | null>(null);
  const [tick, setTick] = useState(0);
  const [posts, setPosts] = useState<PostRecord[] | null>(null);
  const [postsError, setPostsError] = useState<PublicLoadError | null>(null);
  const [postsTick, setPostsTick] = useState(0);
  // 「现有活动」判定基准时刻：挂载时固定一次，避免重渲染间漂移
  const [now] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    getPublicActivities('current')
      .then((res) => {
        if (cancelled) return;
        setActivities(res.activities);
        // 重试成功后清除此前的错误提示与重试按钮
        setActivitiesError(null);
      })
      .catch((err) => {
        if (!cancelled) setActivitiesError(toPublicLoadError(normalizeApiError(err)));
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => {
    let cancelled = false;
    getPublicPosts(2)
      .then((items) => {
        if (cancelled) return;
        setPosts(items);
        setPostsError(null);
      })
      .catch((err) => {
        if (!cancelled) setPostsError(toPublicLoadError(normalizeApiError(err)));
      });
    return () => {
      cancelled = true;
    };
  }, [postsTick]);

  return (
    <HomePageView
      now={now}
      activities={activities}
      activitiesError={activitiesError}
      posts={posts}
      postsError={postsError}
      onRetryActivities={() => setTick((t) => t + 1)}
      onRetryPosts={() => setPostsTick((t) => t + 1)}
      actions={<AccountActions />}
    />
  );
}
