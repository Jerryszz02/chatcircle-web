import type PocketBase from 'pocketbase';
import {
  ACCOUNT_EVENT_ENDPOINTS,
  ACTIVITY_LIVE_REALTIME_SOURCES,
  type ActivityLiveSummaryResponse,
} from '../../../shared/api/accountEvent';
import { apiGet, normalizeApiError, type ApiError } from '../../../shared/api/http';

/**
 * T3 单活动工作台的 Realtime 失效化服务。
 *
 * 顺序固定为“先订阅，再拉快照”；record event 不参与指标计算，只在防抖后重拉
 * live-summary。每次 PB_CONNECT（初次连接除外）都视为断线恢复并无条件刷新，避免漏事件。
 * T4 页面只需消费 snapshot/status/error，不应再实现一套订阅与重连逻辑。
 */

export type ActivityLiveConnectionStatus = 'connecting' | 'online' | 'offline';

export interface ActivityLiveSubscriptionOptions {
  client: PocketBase;
  activityId: string;
  onSnapshot: (snapshot: ActivityLiveSummaryResponse) => void;
  onStatusChange?: (status: ActivityLiveConnectionStatus) => void;
  onError?: (error: ApiError) => void;
  debounceMs?: number;
  connectionPollMs?: number;
}

export type StopActivityLiveSubscription = () => Promise<void>;

const sourceFilters = (client: PocketBase, activityId: string) => ({
  activities: client.filter('id = {:activityId}', { activityId }),
  registrations: client.filter('activity_id = {:activityId}', { activityId }),
  checkins: client.filter('activity_id = {:activityId}', { activityId }),
  activity_surveys: client.filter('activity_id = {:activityId}', { activityId }),
  submissions: client.filter('activity_survey_id.activity_id = {:activityId}', { activityId }),
  activity_pairs: client.filter('activity_id = {:activityId}', { activityId }),
});

export async function subscribeActivityLiveSummary(
  options: ActivityLiveSubscriptionOptions,
): Promise<StopActivityLiveSubscription> {
  const {
    client,
    activityId,
    onSnapshot,
    onStatusChange,
    onError,
    debounceMs = 250,
    connectionPollMs = 500,
  } = options;

  let stopped = false;
  let initialized = false;
  let status: ActivityLiveConnectionStatus = 'connecting';
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let connectionTimer: ReturnType<typeof setInterval> | undefined;
  let latestRequest = 0;
  const unsubscribe: Array<() => Promise<void>> = [];

  const setStatus = (next: ActivityLiveConnectionStatus) => {
    if (status === next) return;
    status = next;
    onStatusChange?.(next);
  };

  const refresh = async (isInitial = false) => {
    const requestId = ++latestRequest;
    try {
      const snapshot = await apiGet<ActivityLiveSummaryResponse>(
        client,
        ACCOUNT_EVENT_ENDPOINTS.activityLiveSummary(activityId),
      );
      if (!stopped && requestId === latestRequest) onSnapshot(snapshot);
    } catch (error) {
      const normalized = normalizeApiError(error);
      if (isInitial) throw normalized;
      if (!stopped) onError?.(normalized);
    }
  };

  const scheduleRefresh = (delay = debounceMs) => {
    if (stopped) return;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void refresh();
    }, Math.max(0, delay));
  };

  const stop: StopActivityLiveSubscription = async () => {
    if (stopped) return;
    stopped = true;
    latestRequest += 1;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    if (connectionTimer !== undefined) clearInterval(connectionTimer);
    await Promise.allSettled(unsubscribe.splice(0).map((release) => release()));
  };

  try {
    const releaseConnect = await client.realtime.subscribe('PB_CONNECT', () => {
      setStatus('online');
      if (initialized) scheduleRefresh(0);
    });
    unsubscribe.push(releaseConnect);

    const filters = sourceFilters(client, activityId);
    for (const source of ACTIVITY_LIVE_REALTIME_SOURCES) {
      const filter = filters[source];
      const release = await client.collection(source).subscribe(
        '*',
        () => scheduleRefresh(),
        { query: { filter } },
      );
      unsubscribe.push(release);
    }

    await refresh(true);
    initialized = true;
    setStatus(client.realtime.isConnected ? 'online' : 'offline');

    connectionTimer = setInterval(() => {
      if (!client.realtime.isConnected) setStatus('offline');
    }, Math.max(100, connectionPollMs));

    return stop;
  } catch (error) {
    await stop();
    throw normalizeApiError(error);
  }
}
