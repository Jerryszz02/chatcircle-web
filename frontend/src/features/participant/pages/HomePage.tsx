import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { normalizeApiError, type ApiError } from '../../../shared/api/http';
import type { PostRecord } from '../../../shared/api/types';
import { Button, Loading } from '../../../shared/ui';
import { getPublicActivities, getPublicPosts, type PublicActivityListItem } from '../api';
import { ActivityCard } from '../components/ActivityCard';
import { PublicPageLayout } from '../components/PublicPageLayout';
import { PublicPostCard } from '../components/PublicPostCard';
import { isCurrentActivity } from '../lib/activitySplit';
import heroEventPhoto from '../../../assets/brand/hero-event-photo.jpg';

/**
 * 首页（/，未登录可看）：Chat Circles C 端品牌官网落地页（2026-08 UI 重构）。
 * 区块：Hero（品牌 + 首场活动真实照片）→ 现有活动（公开活动 API 真实数据，最近 2 场 + 查看全部）→
 * 往期活动（后台公开推文，最近 2 篇 + 查看全部）→
 * 我们的影响（首场试点真实数据，诚实标注样本口径）。
 * 浏览活动不需要账号；报名活动在对应链路内完成手机号认证。
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

export function HomePage() {
  // key 随每次导航变化（含重复点击同一锚点链接），用于触发重复滚动
  const { hash, key } = useLocation();
  const [activities, setActivities] = useState<PublicActivityListItem[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);
  const [posts, setPosts] = useState<PostRecord[] | null>(null);
  const [postsError, setPostsError] = useState<ApiError | null>(null);
  const [postsTick, setPostsTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getPublicActivities('current')
      .then((res) => {
        if (cancelled) return;
        setActivities(res.activities);
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

  useEffect(() => {
    let cancelled = false;
    getPublicPosts(HOME_ACTIVITY_LIMIT)
      .then((items) => {
        if (cancelled) return;
        setPosts(items);
        setPostsError(null);
      })
      .catch((err) => {
        if (!cancelled) setPostsError(normalizeApiError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [postsTick]);

  // 锚点直达（如 /#past，兼容旧的外部分享链接）：等现有活动请求落定（数据或错误其一）
  // 再滚动，避免上方布局变化导致错位（同 ActivitiesPage 的锚点处理）；
  // key 入依赖使 hash 不变时的重复点击也能重新滚动。
  const homeDataSettled =
    (activities !== null || error !== null) && (posts !== null || postsError !== null);
  useEffect(() => {
    if (!hash || !homeDataSettled) return;
    const el = document.getElementById(hash.slice(1));
    el?.scrollIntoView();
  }, [hash, key, homeDataSettled]);

  return (
    <PublicPageLayout>
      <HeroSection />
      <UpcomingActivitiesSection
        activities={activities}
        error={error}
        onRetry={() => setTick((t) => t + 1)}
      />
      <PastPostsSection
        posts={posts}
        error={postsError}
        onRetry={() => setPostsTick((t) => t + 1)}
      />
      <ImpactSection />
    </PublicPageLayout>
  );
}

/* ---------- Hero：品牌主张 + 首场活动现场照片 ---------- */

function HeroSection() {
  return (
    <section className="ccp-hero-wrap" aria-label="品牌介绍">
      <div className="ccp-hero">
        <div className="ccp-hero-rings" aria-hidden="true">
          <span />
          <span />
        </div>
        <p className="ccp-hero-eyebrow">青年心理健康公益项目</p>
        <h1 className="ccp-hero-title">
          一个安全、温暖的倾诉空间，让每位青年被<em>真正听见</em>
        </h1>
        <p className="ccp-hero-sub">
          Chat Circles 把经过 3
          小时专业培训的志愿者「倾听者」，与正处于升学、初入职场等过渡期的青年一对一配对——在轻松的空间里进行一场
          60 分钟的结构化对话：没有评判，没有说教，只有真正的倾听。
        </p>
        <Link to="/activities" className="cc-btn cc-btn-primary ccp-hero-cta">
          浏览活动
        </Link>
      </div>
      {/* Hero 大图：首场活动现场真实照片（2026-06-12，1920px 宽压缩版，原图 3520px） */}
      <img
        src={heroEventPhoto}
        alt="Chat Circles 首场活动现场：青年与倾听者围桌对话"
        className="ccp-hero-photo"
      />
    </section>
  );
}

/* ---------- 现有活动：公开活动 API 真实数据（数据请求上移至 HomePage，供锚点滚动依赖） ---------- */

function UpcomingActivitiesSection({
  activities,
  error,
  onRetry,
}: {
  activities: PublicActivityListItem[] | null;
  error: ApiError | null;
  onRetry: () => void;
}) {
  // 现有活动：已结束（closed 或 end_time 已过）的不在首页展示；最多 2 张卡片，全部见 /activities
  const upcoming = (activities ?? [])
    .filter((a) => isCurrentActivity(a))
    .slice(0, HOME_ACTIVITY_LIMIT);

  return (
    <section aria-labelledby="home-activities">
      <div className="ccp-section-head">
        <h2 className="ccp-section-title" id="home-activities">
          现有活动
        </h2>
        <Link to="/activities" className="ccp-section-more">
          查看全部 →
        </Link>
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
  posts: PostRecord[] | null;
  error: ApiError | null;
  onRetry: () => void;
}) {
  return (
    <section className="ccp-anchor" id="past" aria-labelledby="home-past">
      <div className="ccp-section-head">
        <h2 className="ccp-section-title" id="home-past">
          往期活动
        </h2>
        <Link to="/activities/past" className="ccp-section-more">
          查看全部 →
        </Link>
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
    <section aria-labelledby="home-impact">
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
