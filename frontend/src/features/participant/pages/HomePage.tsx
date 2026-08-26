import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { normalizeApiError, type ApiError } from '../../../shared/api/http';
import { Button, Loading } from '../../../shared/ui';
import { getPublicActivities, type PublicActivityListItem } from '../api';
import { ActivityCard } from '../components/ActivityCard';
import { PublicPageLayout } from '../components/PublicPageLayout';
import { isCurrentActivity, isPastActivity } from '../lib/activitySplit';

/**
 * 首页（/，未登录可看）：Chat Circles C 端品牌官网落地页（2026-08 UI 重构）。
 * 区块：Hero（品牌 + 大图占位）→ 现有活动（公开活动 API 真实数据，最近 2 场 + 查看全部）→
 * 往期活动（已结束场次真实数据，最近 2 场 + 查看全部；活动故事并入同一区块，
 * 故事仍为静态占位，待后端任务对接）→ 我们的影响（首场试点真实数据，诚实标注样本口径）。
 * 所有图片均为占位块，待品牌素材（logo / 活动照片）到位后替换。
 * 浏览活动不需要账号；报名活动在对应链路内登录/自动注册（FR-AUTH-001）。
 */

/* ---------- 静态占位内容（待后端任务提供真实数据后替换为接口/配置） ---------- */

/** 活动故事/回顾占位：url 为公众号文章外链，空串表示暂未上线（卡片不渲染跳转）。 */
const STORY_PLACEHOLDERS: { title: string; excerpt: string; url: string }[] = [
  {
    title: '首场活动回顾｜当 13 位青年遇见 15 位倾听者',
    excerpt:
      '正念开场、一杯饮品、60 分钟一对一对话——回顾 2026 年 6 月 12 日的首场 Chat Circles，看看那个下午发生了什么。',
    url: '',
  },
  {
    title: '倾听者手记｜不给建议，也是一种温柔',
    excerpt:
      '「我学到的最重要的事：把建议咽回去，把耳朵递过去。」一位企业员工倾听者的第一次服务记录。',
    url: '',
  },
];

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

export function HomePage() {
  // key 随每次导航变化（含重复点击同一锚点链接），用于触发重复滚动
  const { hash, key } = useLocation();
  const [activities, setActivities] = useState<PublicActivityListItem[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getPublicActivities()
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

  // 锚点直达（如 /#past，兼容旧的外部分享链接）：等现有活动请求落定（数据或错误其一）
  // 再滚动，避免上方布局变化导致错位（同 ActivitiesPage 的锚点处理）；
  // key 入依赖使 hash 不变时的重复点击也能重新滚动。
  const activitiesSettled = activities !== null || error !== null;
  useEffect(() => {
    if (!hash || !activitiesSettled) return;
    const el = document.getElementById(hash.slice(1));
    el?.scrollIntoView();
  }, [hash, key, activitiesSettled]);

  return (
    <PublicPageLayout>
      <HeroSection />
      <UpcomingActivitiesSection
        activities={activities}
        error={error}
        onRetry={() => setTick((t) => t + 1)}
      />
      <PastActivitySection activities={activities} />
      <ImpactSection />
    </PublicPageLayout>
  );
}

/* ---------- Hero：品牌主张 + 大图占位 ---------- */

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
      {/* Hero 大图占位：待首场活动真实照片（注意肖像授权，优先背影/局部特写）替换 */}
      <div className="ccp-photo ccp-photo-hero" role="img" aria-label="活动现场照片（素材待补充）">
        活动现场照片
      </div>
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
  const upcoming = (activities ?? []).filter((a) => isCurrentActivity(a)).slice(0, 2);

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
            <ActivityCard key={activity.id} activity={activity} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/* ---------- 往期活动：已结束场次真实数据（最多 2 张 + 查看全部）；活动故事并入本区块（静态占位，待后端任务对接） ---------- */

function PastActivitySection({ activities }: { activities: PublicActivityListItem[] | null }) {
  // 往期活动：closed 或 end_time 已过的场次；最多 2 张卡片，全部见 /activities/past
  const past = (activities ?? []).filter((a) => isPastActivity(a)).slice(0, 2);

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
      {activities !== null && past.length === 0 ? <p className="cc-empty">暂无往期活动。</p> : null}
      {past.length > 0 ? (
        <ul className="ccp-card-grid">
          {past.map((activity) => (
            <ActivityCard key={activity.id} activity={activity} />
          ))}
        </ul>
      ) : null}
      <ul className="ccp-card-grid">
        {STORY_PLACEHOLDERS.map((story) => (
          <li key={story.title} className="ccp-card">
            {/* 文章配图占位：待真实图片素材替换 */}
            <div className="ccp-photo ccp-photo-card" aria-hidden="true">
              文章配图
            </div>
            <div className="ccp-card-body">
              <h3 className="ccp-card-title">{story.title}</h3>
              <p className="cc-item-meta">{story.excerpt}</p>
              {story.url ? (
                <a
                  href={story.url}
                  target="_blank"
                  rel="noreferrer"
                  className="cc-btn cc-btn-secondary cc-btn-block"
                >
                  阅读原文（公众号）
                </a>
              ) : (
                <p className="cc-item-meta">全文即将上线，敬请期待。</p>
              )}
            </div>
          </li>
        ))}
      </ul>
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
