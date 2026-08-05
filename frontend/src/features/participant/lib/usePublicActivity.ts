import { useCallback, useEffect, useState } from 'react';
import { normalizeApiError, type ApiError } from '../../../shared/api/http';
import { getPublicActivity, type PublicActivityDetail } from '../api';

/**
 * 公开活动详情加载 hook（/a/:activityId 详情页与报名页共用）。
 * 未登录也可访问（FR-ACT-003）；仅 published/closed 活动由服务端放行，
 * 其余状态按 404/403 处理并展示「活动不存在或未开放」。
 */
export function usePublicActivity(activityId: string | undefined) {
  const [data, setData] = useState<PublicActivityDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!activityId) {
      setError(normalizeApiError(new Error('缺少活动标识')));
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPublicActivity(activityId)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(normalizeApiError(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activityId, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
