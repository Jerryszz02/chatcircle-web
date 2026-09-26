import type { ReactNode } from 'react';
import { AboutPageView } from '../features/participant/pages/AboutPageView';
import { ActivitiesPageView } from '../features/participant/pages/ActivitiesPageView';
import { ActivityDetailPageView } from '../features/participant/pages/ActivityDetailPageView';
import { HomePageView } from '../features/participant/pages/HomePageView';
import { PastActivitiesPageView } from '../features/participant/pages/PastActivitiesPageView';
import { PostPageView } from '../features/participant/pages/PostPageView';
import { PrivacyPageView } from '../features/participant/pages/PrivacyPageView';
import { CurrentPathProvider } from './nav';
import type { PublicRouteMatch } from './routes';
import type { PublicPageData } from './types';

/**
 * 公开页服务端渲染根组件（纯）：按路由 + 首屏数据渲染对应纯展示视图。
 *
 * 与浏览器 hydrate 首帧的约定：
 * - 不传 actions / surveysSlot / personalSlot / 重试回调——客户端首帧同样
 *   以默认值渲染（ClientOnly 占位 = 服务端默认输出），保证逐字节一致；
 * - now 一律取 data.generatedAt，现有/往期判定两端一致。
 */
export function PublicApp({ match, data }: { match: PublicRouteMatch; data: PublicPageData }) {
  const now = new Date(data.generatedAt);
  let page: ReactNode;
  switch (data.kind) {
    case 'home':
      page = (
        <HomePageView
          now={now}
          activities={data.activities}
          activitiesError={data.activitiesError}
          posts={data.posts}
          postsError={data.postsError}
        />
      );
      break;
    case 'about':
      page = <AboutPageView />;
      break;
    case 'privacy':
      page = <PrivacyPageView />;
      break;
    case 'activities':
      page = (
        <ActivitiesPageView
          now={now}
          activities={data.activities}
          activitiesError={data.activitiesError}
        />
      );
      break;
    case 'past':
      page = <PastActivitiesPageView posts={data.posts} postsError={data.postsError} />;
      break;
    case 'activity':
      page = (
        <ActivityDetailPageView
          activityId={match.params.id ?? ''}
          detail={data.detail}
          error={null}
          loading={false}
        />
      );
      break;
    case 'post':
      page = <PostPageView post={data.post} error={null} />;
      break;
  }
  return <CurrentPathProvider value={match.pathname}>{page}</CurrentPathProvider>;
}
