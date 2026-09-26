import { useState } from 'react';
import { normalizeApiError } from '../shared/api/http';
import { AccountActions } from '../features/participant/components/AccountActions';
import { MyPairingCard } from '../features/participant/components/MyPairingCard';
import {
  getPublicActivities,
  getPublicActivity,
  getPublicPosts,
} from '../features/participant/api';
import { AuthedSurveys } from '../features/participant/pages/ActivitiesPage';
import { ActivitiesPageView, SurveysGuide } from '../features/participant/pages/ActivitiesPageView';
import { AboutPageView } from '../features/participant/pages/AboutPageView';
import { ActivityDetailPageView } from '../features/participant/pages/ActivityDetailPageView';
import { HomePageView } from '../features/participant/pages/HomePageView';
import { PastActivitiesPageView } from '../features/participant/pages/PastActivitiesPageView';
import { PostPageView } from '../features/participant/pages/PostPageView';
import { PrivacyPageView } from '../features/participant/pages/PrivacyPageView';
import { ClientOnly } from './ClientOnly';
import { toPublicLoadError } from './loadError';
import { CurrentPathProvider } from './nav';
import type { PublicRouteMatch } from './routes';
import type {
  PublicActivityDetailView,
  PublicActivitySummary,
  PublicLoadError,
  PublicPageData,
  PublicPostView,
} from './types';

/**
 * 公开页 hydrate 客户端页面组件（仅浏览器 bundle 使用，禁止进入服务端渲染图：
 * 经 participant/api / shared/pocketbase 取数）。
 *
 * 首帧与服务端输出逐字节一致：useState 初始值全部来自 __CC_PUBLIC_DATA__
 * （不 refetch），now 取 data.generatedAt；会话敏感区经 ClientOnly 岛屿
 * 挂载后替换；重试/刷新才发起浏览器端请求。
 */

/** 问卷区客户端岛屿（placeholder 与服务端默认输出的匿名指引态一致）。 */
function SurveysIsland() {
  return (
    <ClientOnly
      placeholder={<SurveysGuide hint="登录后，您可以填写的问卷也会显示在这里。" showLogin />}
    >
      <AuthedSurveys />
    </ClientOnly>
  );
}

function HomeClientPage({ data }: { data: Extract<PublicPageData, { kind: 'home' }> }) {
  const [now] = useState(() => new Date(data.generatedAt));
  const [activities, setActivities] = useState<PublicActivitySummary[] | null>(data.activities);
  const [activitiesError, setActivitiesError] = useState<PublicLoadError | null>(
    data.activitiesError,
  );
  const [posts, setPosts] = useState<PublicPostView[] | null>(data.posts);
  const [postsError, setPostsError] = useState<PublicLoadError | null>(data.postsError);

  const retryActivities = () => {
    getPublicActivities('current')
      .then((res) => {
        setActivities(res.activities);
        setActivitiesError(null);
      })
      .catch((err) => setActivitiesError(toPublicLoadError(normalizeApiError(err))));
  };
  const retryPosts = () => {
    getPublicPosts(2)
      .then((items) => {
        setPosts(items);
        setPostsError(null);
      })
      .catch((err) => setPostsError(toPublicLoadError(normalizeApiError(err))));
  };

  return (
    <HomePageView
      now={now}
      activities={activities}
      activitiesError={activitiesError}
      posts={posts}
      postsError={postsError}
      onRetryActivities={retryActivities}
      onRetryPosts={retryPosts}
      actions={<AccountActions />}
    />
  );
}

function ActivitiesClientPage({ data }: { data: Extract<PublicPageData, { kind: 'activities' }> }) {
  const [now] = useState(() => new Date(data.generatedAt));
  const [activities, setActivities] = useState<PublicActivitySummary[] | null>(data.activities);
  const [activitiesError, setActivitiesError] = useState<PublicLoadError | null>(
    data.activitiesError,
  );

  const retryActivities = () => {
    getPublicActivities('current')
      .then((res) => {
        setActivities(res.activities);
        setActivitiesError(null);
      })
      .catch((err) => setActivitiesError(toPublicLoadError(normalizeApiError(err))));
  };

  return (
    <ActivitiesPageView
      now={now}
      activities={activities}
      activitiesError={activitiesError}
      onRetryActivities={retryActivities}
      surveysSlot={<SurveysIsland />}
      actions={<AccountActions />}
    />
  );
}

function PastClientPage({ data }: { data: Extract<PublicPageData, { kind: 'past' }> }) {
  const [posts, setPosts] = useState<PublicPostView[] | null>(data.posts);
  const [postsError, setPostsError] = useState<PublicLoadError | null>(data.postsError);

  const retryPosts = () => {
    getPublicPosts()
      .then((items) => {
        setPosts(items);
        setPostsError(null);
      })
      .catch((err) => setPostsError(toPublicLoadError(normalizeApiError(err))));
  };

  return (
    <PastActivitiesPageView
      posts={posts}
      postsError={postsError}
      onRetryPosts={retryPosts}
      actions={<AccountActions />}
    />
  );
}

function ActivityClientPage({
  data,
  activityId,
}: {
  data: Extract<PublicPageData, { kind: 'activity' }>;
  activityId: string;
}) {
  const [detail, setDetail] = useState<PublicActivityDetailView | null>(data.detail);
  const [error, setError] = useState<PublicLoadError | null>(null);

  const retry = () => {
    getPublicActivity(activityId)
      .then((res) => {
        // 只取公开展示所需字段；registration_fields 属报名编辑器数据，不进本页
        setDetail({ activity: res.activity, registration: res.registration });
        setError(null);
      })
      .catch((err) => setError(toPublicLoadError(normalizeApiError(err))));
  };

  return (
    <ActivityDetailPageView
      activityId={activityId}
      detail={detail}
      error={error}
      loading={false}
      onRetry={retry}
      personalSlot={
        <ClientOnly>
          <MyPairingCard activityId={activityId} />
        </ClientOnly>
      }
      actions={<AccountActions />}
    />
  );
}

function PostClientPage({ data }: { data: Extract<PublicPageData, { kind: 'post' }> }) {
  // SSR 已拿到全文；客户端无重试需求（刷新即整页 document navigation）
  return <PostPageView post={data.post} error={null} actions={<AccountActions />} />;
}

/** hydrate 根组件：按首帧数据渲染对应客户端页面（含账号区/会话岛屿）。 */
export function PublicClientApp({
  data,
  match,
}: {
  data: PublicPageData;
  match: PublicRouteMatch;
}) {
  let page;
  switch (data.kind) {
    case 'home':
      page = <HomeClientPage data={data} />;
      break;
    case 'about':
      page = <AboutPageView actions={<AccountActions />} />;
      break;
    case 'privacy':
      page = <PrivacyPageView actions={<AccountActions />} />;
      break;
    case 'activities':
      page = <ActivitiesClientPage data={data} />;
      break;
    case 'past':
      page = <PastClientPage data={data} />;
      break;
    case 'activity':
      page = <ActivityClientPage data={data} activityId={match.params.id ?? ''} />;
      break;
    case 'post':
      page = <PostClientPage data={data} />;
      break;
  }
  return <CurrentPathProvider value={match.pathname}>{page}</CurrentPathProvider>;
}
