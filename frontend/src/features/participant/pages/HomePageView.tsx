import { useEffect, type ReactNode } from 'react';
import { NavAnchor } from '../../../public/nav';
import type { PublicActivitySummary, PublicLoadError, PublicPostView } from '../../../public/types';
import { Button, Loading } from '../../../shared/ui';
import { ActivityCard } from '../components/ActivityCard';
import { PublicPageLayout } from '../components/PublicPageLayout';
import { PublicPostCard } from '../components/PublicPostCard';
import { isCurrentActivity } from '../lib/activitySplit';
import heroEventPhoto from '../../../assets/brand/hero-event-photo.jpg';
import './home.css';

/**
 * 首页纯展示视图（SSR 安全：仅依赖纯模块，不触碰会话/pb client/window 模块级状态）。
 * 数据与错误由容器（SPA）或服务端 loader 注入；now 由调用方统一给定
 * （SSR 与 hydrate 首帧共用 generatedAt，杜绝现有/往期判定在两端不一致）。
 * 锚点滚动读取 window.location.hash（公开页一律 document navigation，
 * 首屏 hash 滚动由浏览器原生完成，effect 兜底 SPA 内到达与 hashchange）。
 */

/** Our Impact：首场试点真实数据（2026-06-12 匿名问卷，倾诉者 n=13、倾听者 n=15）。 */
const IMPACT_METRICS = [
  { value: '77%', note: '参与者认同「今天的对话让我感到被真正倾听」' },
  { value: '−2.15', note: '倾诉者自报压力变化（0–10 分，5.08 → 2.92）' },
  { value: '+1.00', note: '倾诉者积极情绪变化（1–5 分，2.43 → 3.43）' },
  { value: '60', note: '倾听者净推荐值 NPS（0–10 分推荐意愿）' },
  { value: '73%', note: '倾听者愿意再次担任志愿服务' },
];

const IMPACT_QUOTE = {
  text: '一个暂停下来、梳理自己的机会……结束后很有力量。',
  source: '首场活动倾诉者 · 离场问卷',
};

/** 首页“现有活动”和“往期活动”各自展示的卡片上限。 */
const HOME_ACTIVITY_LIMIT = 2;

export interface HomePageViewProps {
  /** 「现有活动」判定的基准时刻（SSR 与 hydrate 首帧须为同一值）。 */
  now: Date;
  activities: PublicActivitySummary[] | null;
  activitiesError: PublicLoadError | null;
  posts: PublicPostView[] | null;
  postsError: PublicLoadError | null;
  /** 重试回调（浏览器端注入；SSR 缺省，按钮仅作占位，hydrate 后生效）。 */
  onRetryActivities?: () => void;
  onRetryPosts?: () => void;
  /** 站点头部账号区插槽（SPA/hydrate 传 AccountActions；SSR 缺省为默认登录链接）。 */
  actions?: ReactNode;
}

export function HomePageView({
  now,
  activities,
  activitiesError,
  posts,
  postsError,
  onRetryActivities,
  onRetryPosts,
  actions,
}: HomePageViewProps) {
  // 锚点直达（如 /#past，兼容旧的外部分享链接）：等数据请求落定（数据或错误其一）
  // 再滚动，避免上方布局变化导致错位。
  const dataSettled =
    (activities !== null || activitiesError !== null) && (posts !== null || postsError !== null);
  useEffect(() => {
    if (!dataSettled) return;
    const scrollToHash = () => {
      const hash = window.location.hash;
      if (!hash) return;
      document.getElementById(hash.slice(1))?.scrollIntoView();
    };
    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
    return () => window.removeEventListener('hashchange', scrollToHash);
  }, [dataSettled]);

  return (
    <PublicPageLayout className="ccp-home" actions={actions}>
      <HeroSection />
      <UpcomingActivitiesSection
        now={now}
        activities={activities}
        error={activitiesError}
        onRetry={onRetryActivities}
      />
      <PastPostsSection posts={posts} error={postsError} onRetry={onRetryPosts} />
      <ImpactSection />
    </PublicPageLayout>
  );
}

/* ---------- Hero：品牌主张 + 首场活动现场照片 ---------- */

function HeroSection() {
  return (
    <section className="ccp-home-introduction" aria-label="品牌介绍">
      <div className="ccp-home-hero">
        <div className="ccp-home-container">
          <p className="ccp-home-eyebrow">青年心理健康公益项目</p>
          <h1 className="ccp-home-title">
            <span>一个安全、温暖的</span>
            <span>倾诉空间，</span>
            <br />
            <span>让每位青年</span>
            <span>被真正听见</span>
          </h1>
          <NavAnchor href="/activities" className="ccp-home-browse">
            浏览活动 <span aria-hidden="true">↗</span>
          </NavAnchor>
        </div>
      </div>
      <div className="ccp-home-intro ccp-home-container">
        <img
          src={heroEventPhoto}
          alt="Chat Circles 首场活动现场：青年与倾听者围桌对话"
          className="ccp-home-photo"
        />
        <p>
          Chat Circles 把经过 3
          小时专业培训的志愿者「倾听者」，与正处于升学、初入职场等过渡期的青年一对一配对——在轻松的空间里进行一场
          60 分钟的结构化对话：没有评判，没有说教，只有真正的倾听。
        </p>
      </div>
    </section>
  );
}

/* ---------- 现有活动：公开活动数据（最多 2 张卡片，全部见 /activities） ---------- */

function UpcomingActivitiesSection({
  now,
  activities,
  error,
  onRetry,
}: {
  now: Date;
  activities: PublicActivitySummary[] | null;
  error: PublicLoadError | null;
  onRetry?: () => void;
}) {
  // 现有活动：已结束（closed 或 end_time 已过）的不在首页展示；最多 2 张卡片，全部见 /activities
  const upcoming = (activities ?? [])
    .filter((a) => isCurrentActivity(a, now))
    .slice(0, HOME_ACTIVITY_LIMIT);

  return (
    <section className="ccp-home-section ccp-home-container" aria-labelledby="home-activities">
      <div className="ccp-section-head">
        <h2 className="ccp-section-title" id="home-activities">
          现有活动
        </h2>
        <NavAnchor href="/activities" className="ccp-section-more">
          查看全部 →
        </NavAnchor>
      </div>

      {activities === null && !error ? <Loading /> : null}

      {error ? (
        <>
          <p className="cc-empty">{error.message}</p>
          <Button variant="secondary" onClick={onRetry}>
            重试
          </Button>
        </>
      ) : null}

      {activities !== null && upcoming.length === 0 ? (
        <p className="cc-empty">新活动筹备中，敬请期待。</p>
      ) : null}

      {upcoming.length > 0 ? (
        <ul className="ccp-card-grid">
          {upcoming.map((activity) => (
            <ActivityCard key={activity.id} activity={activity} showCover={false} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/* ---------- 往期活动：后台公开推文（最多 2 篇 + 查看全部） ---------- */

function PastPostsSection({
  posts,
  error,
  onRetry,
}: {
  posts: PublicPostView[] | null;
  error: PublicLoadError | null;
  onRetry?: () => void;
}) {
  return (
    <section
      className="ccp-home-section ccp-home-container ccp-anchor"
      id="past"
      aria-labelledby="home-past"
    >
      <div className="ccp-section-head">
        <h2 className="ccp-section-title" id="home-past">
          往期活动
        </h2>
        <NavAnchor href="/activities/past" className="ccp-section-more">
          查看全部 →
        </NavAnchor>
      </div>
      {posts === null && !error ? <Loading /> : null}
      {error ? (
        <>
          <p className="cc-empty">{error.message}</p>
          <Button variant="secondary" onClick={onRetry}>
            重试
          </Button>
        </>
      ) : null}
      {posts !== null && posts.length === 0 ? <p className="cc-empty">暂无往期活动。</p> : null}
      {posts && posts.length > 0 ? (
        <ul className="ccp-card-grid">
          {posts.slice(0, HOME_ACTIVITY_LIMIT).map((post) => (
            <PublicPostCard key={post.id} post={post} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/* ---------- 我们的影响：首场试点真实数据（小样本自报，诚实呈现） ---------- */

function ImpactSection() {
  return (
    <section className="ccp-home-section ccp-home-container" aria-labelledby="home-impact">
      <div className="ccp-section-head">
        <h2 className="ccp-section-title" id="home-impact">
          我们的影响
        </h2>
        <span className="ccp-section-note">首场试点 · 2026 年 6 月</span>
      </div>
      <ul className="ccp-metric-grid">
        {IMPACT_METRICS.map((metric) => (
          <li key={metric.note} className="cc-metric">
            <p className="cc-metric-value">{metric.value}</p>
            <p className="cc-metric-note">{metric.note}</p>
          </li>
        ))}
      </ul>
      <blockquote className="ccp-quote">
        <p className="ccp-quote-text">「{IMPACT_QUOTE.text}」</p>
        <cite className="ccp-quote-source">—— {IMPACT_QUOTE.source}</cite>
      </blockquote>
      <p className="ccp-impact-footnote">
        数据来自 2026-06-12 首场活动前、离场时的匿名问卷（13 位倾诉者、15
        位倾听者）。当前为单场试点的小样本自报数据，我们将其作为关联性证据诚实呈现。
      </p>
    </section>
  );
}
