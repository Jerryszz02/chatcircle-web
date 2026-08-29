import type PocketBase from 'pocketbase';
import {
  ACCOUNT_EVENT_ENDPOINTS,
  participantPairingRealtimeTopic,
  type MyPairingResponse,
} from '../../../shared/api/accountEvent';
import { apiGet, normalizeApiError, type ApiError } from '../../../shared/api/http';

/**
 * T5 参与者配对状态的 Realtime 失效化服务（模式同管理端 admin/lib/activityLive.ts）。
 *
 * 顺序固定为“先订阅，再拉快照”：
 * - 本人 checkins record event（按 participant_id + activity_id 过滤，参与者对
 *   activity_pairs 无订阅权限，签到撤销/重签由本人 checkins 事件覆盖）；
 * - 自定义 topic `cc.participant.pairing.{participantId}`（T2 配对事务提交后发送的
 *   最小失效消息；topic 与本人无关的活动消息在此按 activity_id 丢弃）。
 * 事件不参与任何配对推导，只在防抖后重拉 my-pairing；每次 PB_CONNECT（初次连接除外）
 * 都视为断线恢复并无条件刷新，避免漏事件。
 *
 * 降级：Realtime 订阅本身失败（如极端 WebView 环境）时仍下发一次性快照并报告 offline，
 * 页面可手动重试；成功路径不受影响。
 */

export type MyPairingConnectionStatus = 'connecting' | 'online' | 'offline';

export interface MyPairingSubscriptionOptions {
  client: PocketBase;
  activityId: string;
  participantId: string;
  onSnapshot: (snapshot: MyPairingResponse) => void;
  onStatusChange?: (status: MyPairingConnectionStatus) => void;
  onError?: (error: ApiError) => void;
  debounceMs?: number;
  connectionPollMs?: number;
}

export type StopMyPairingSubscription = () => Promise<void>;

export async function subscribeMyPairing(
  options: MyPairingSubscriptionOptions,
): Promise<StopMyPairingSubscription> {
  const {
    client,
    activityId,
    participantId,
    onSnapshot,
    onStatusChange,
    onError,
    debounceMs = 250,
    connectionPollMs = 500,
  } = options;

  let stopped = false;
  let initialized = false;
  let status: MyPairingConnectionStatus = 'connecting';
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let connectionTimer: ReturnType<typeof setInterval> | undefined;
  let latestRequest = 0;
  const unsubscribe: Array<() => Promise<void>> = [];

  const setStatus = (next: MyPairingConnectionStatus) => {
    if (status === next) return;
    status = next;
    onStatusChange?.(next);
  };

  const refresh = async (isInitial = false) => {
    const requestId = ++latestRequest;
    try {
      const snapshot = await apiGet<MyPairingResponse>(
        client,
        ACCOUNT_EVENT_ENDPOINTS.myPairing(activityId),
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

  const stop: StopMyPairingSubscription = async () => {
    if (stopped) return;
    stopped = true;
    latestRequest += 1;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    if (connectionTimer !== undefined) clearInterval(connectionTimer);
    await Promise.allSettled(unsubscribe.splice(0).map((release) => release()));
  };

  // Realtime 订阅失败不阻断一次性快照：页面退化为手动刷新（status=offline）。
  let subscribed = true;
  try {
    const releaseConnect = await client.realtime.subscribe('PB_CONNECT', () => {
      setStatus('online');
      if (initialized) scheduleRefresh(0);
    });
    unsubscribe.push(releaseConnect);

    const checkinsFilter = client.filter(
      'participant_id = {:participantId} && activity_id = {:activityId}',
      { participantId, activityId },
    );
    const releaseCheckins = await client
      .collection('checkins')
      .subscribe('*', () => scheduleRefresh(), { query: { filter: checkinsFilter } });
    unsubscribe.push(releaseCheckins);

    const releasePairing = await client.realtime.subscribe(
      participantPairingRealtimeTopic(participantId),
      (data) => {
        // 配对 topic 按参与者投递，消息只含失效信号；与本活动无关的变化直接忽略。
        const message = data as { activity_id?: unknown } | undefined;
        if (message && typeof message.activity_id === 'string' && message.activity_id !== activityId) {
          return;
        }
        scheduleRefresh();
      },
    );
    unsubscribe.push(releasePairing);
  } catch (error) {
    subscribed = false;
    // connect() 失败会在 SDK 内残留 pendingConnects/连接定时器，导致共享 client 上后续
    // subscribe 挂起（connect 直接跳过 initConnect）。从未建立过连接时 unsubscribe()
    // 清掉订阅表并断开，排空残留状态；已有连接时的失败（如提交订阅失败）不影响其他订阅。
    if (!client.realtime.isConnected) void client.realtime.unsubscribe();
    onError?.(normalizeApiError(error));
  }

  try {
    await refresh(true);
    initialized = true;
    setStatus(subscribed && client.realtime.isConnected ? 'online' : 'offline');

    connectionTimer = setInterval(() => {
      if (!client.realtime.isConnected) setStatus('offline');
    }, Math.max(100, connectionPollMs));

    return stop;
  } catch (error) {
    await stop();
    throw normalizeApiError(error);
  }
}
