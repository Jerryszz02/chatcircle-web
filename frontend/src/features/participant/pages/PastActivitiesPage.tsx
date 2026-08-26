import { useEffect, useState } from 'react';
import { normalizeApiError, type ApiError } from '../../../shared/api/http';
import { Button, Loading } from '../../../shared/ui';
import { getPublicActivities, type PublicActivityListItem } from '../api';
import { ActivityCard } from '../components/ActivityCard';
import { PublicPageLayout } from '../components/PublicPageLayout';
import { isPastActivity } from '../lib/activitySplit';

/**
 * 往期活动页（/activities/past，未登录可看）：已结束/已关闭活动的完整列表，
 * 由站点导航与首页「往期活动」区块的「查看全部」进入。
 * 往期判定口径（closed 或 end_time 已过）见 lib/activitySplit.ts；
 * 列表由后端按 start_time 倒序返回，最新场次在前。
 */
export function PastActivitiesPage() {
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

  const past = (activities ?? []).filter((a) => isPastActivity(a));

  return (
    <PublicPageLayout>
      <section>
        <h2 className="ccp-section-title">往期活动</h2>
        {activities === null && !error ? <Loading /> : null}

        {error ? (
          <>
            <p className="cc-empty">{error.message}</p>
            <Button variant="secondary" onClick={() => setTick((t) => t + 1)}>
              重试
            </Button>
          </>
        ) : null}

        {activities !== null && past.length === 0 ? (
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

        {past.length > 0 ? (
          <ul className="ccp-card-grid">
            {past.map((activity) => (
              <ActivityCard key={activity.id} activity={activity} />
            ))}
          </ul>
        ) : null}
      </section>
    </PublicPageLayout>
  );
}
