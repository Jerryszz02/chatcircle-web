import { useEffect, type ReactNode } from 'react';
import type { PublicActivitySummary, PublicLoadError } from '../../../public/types';
import { Button, Loading } from '../../../shared/ui';
import { ActivityCard } from '../components/ActivityCard';
import { PublicPageLayout } from '../components/PublicPageLayout';
import { isCurrentActivity } from '../lib/activitySplit';

/**
 * 活动与问卷页纯展示视图（SSR 安全）。
 * 现有活动区由容器/服务端注入数据；问卷区为插槽：
 * - 服务端 / hydrate 首帧：缺省渲染匿名指引态 SurveysGuide（登录引导）；
 * - 浏览器挂载后：容器经 ClientOnly 替换为会话敏感的开放问卷列表。
 * 锚点（#activities / #surveys）读取 window.location.hash。
 */

export interface ActivitiesPageViewProps {
  /** 「现有活动」判定的基准时刻（SSR 与 hydrate 首帧须为同一值）。 */
  now: Date;
  activities: PublicActivitySummary[] | null;
  activitiesError: PublicLoadError | null;
  onRetryActivities?: () => void;
  /** 问卷区插槽（缺省为匿名指引态）。 */
  surveysSlot?: ReactNode;
  /** 站点头部账号区插槽。 */
  actions?: ReactNode;
}

/**
 * 问卷区指引态（纯组件，SSR 默认输出与 ClientOnly placeholder 共用同一份 markup）：
 * 问卷通过活动现场二维码进入；未登录给登录入口，已登录无可填问卷/其他角色会话只给提示。
 */
export function SurveysGuide({ hint, showLogin }: { hint: string; showLogin: boolean }) {
  return (
    <div className="ccp-empty">
      <span className="ccp-empty-chip" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </span>
      <p className="cc-empty">
        问卷通过活动现场的二维码进入；填写问卷需要登录参与者账号。
        {hint}
      </p>
      {showLogin ? (
        <div className="cc-actions">
          <a href="/login" className="cc-btn cc-btn-primary cc-btn-block">
            登录查看我的问卷
          </a>
        </div>
      ) : null}
    </div>
  );
}

export function ActivitiesPageView({
  now,
  activities,
  activitiesError,
  onRetryActivities,
  surveysSlot,
  actions,
}: ActivitiesPageViewProps) {
  // 锚点直达（如 /activities#surveys）：列表就绪后目标区块才需要滚动补偿。
  const dataSettled = activities !== null || activitiesError !== null;
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

  // 现有活动：已结束（closed 或 end_time 已过）的场次归入往期活动页，不在此展示
  const current = (activities ?? []).filter((a) => isCurrentActivity(a, now));

  return (
    <PublicPageLayout actions={actions}>
      <section id="activities" className="ccp-anchor">
        <h2 className="ccp-section-title">现有活动</h2>
        {activities === null && !activitiesError ? <Loading /> : null}

        {activitiesError ? (
          <>
            <p className="cc-empty">{activitiesError.message}</p>
            <Button variant="secondary" onClick={onRetryActivities}>
              重试
            </Button>
          </>
        ) : null}

        {activities !== null && current.length === 0 ? (
          <div className="ccp-empty">
            <span className="ccp-empty-chip" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
            </span>
            <p className="cc-empty">暂无进行中的活动，请稍后再来。</p>
          </div>
        ) : null}

        {current.length > 0 ? (
          <ul className="ccp-card-grid">
            {current.map((activity) => (
              <ActivityCard key={activity.id} activity={activity} />
            ))}
          </ul>
        ) : null}
      </section>

      <section id="surveys" className="ccp-anchor">
        <h2 className="ccp-section-title">问卷</h2>
        {surveysSlot ?? <SurveysGuide hint="登录后，您可以填写的问卷也会显示在这里。" showLogin />}
      </section>
    </PublicPageLayout>
  );
}
