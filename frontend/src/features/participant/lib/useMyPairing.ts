import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MyPairingResponse } from '../../../shared/api/accountEvent';
import type { ApiError } from '../../../shared/api/http';
import { pbClients } from '../../../shared/pocketbase';
import {
  subscribeMyPairing,
  type MyPairingConnectionStatus,
} from './myPairingLive';

/**
 * 本人配对状态 hook（T5）：先订阅本人 Realtime 失效事件，再拉取 my-pairing 快照；
 * 事件/断线恢复均触发重拉。未登录或活动列表为空时惰性（不发请求、不订阅）。
 *
 * `useMyPairingMap` 一次订阅跟踪多个活动（「我的」中心全部相关报名共用一路订阅），
 * `useMyPairing` 是单活动便捷封装（签到成功页/活动详情页）。
 */
export interface MyPairingEntry {
  snapshot: MyPairingResponse | null;
  /** 最近一次拉取失败（含初始）；已有快照时保留旧快照并由此标记陈旧。 */
  error: ApiError | null;
}

export interface MyPairingMapView {
  /** 按活动 id 的快照/错误；尚未返回的活动没有对应键。 */
  entries: Record<string, MyPairingEntry>;
  status: MyPairingConnectionStatus;
  /** 是否还有活动未完成首轮拉取。 */
  loading: boolean;
  /** 手动重试：整体重建订阅并重拉全部快照。 */
  reload: () => void;
}

export function useMyPairingMap(activityIds: string[]): MyPairingMapView {
  const [entries, setEntries] = useState<Record<string, MyPairingEntry>>({});
  const [status, setStatus] = useState<MyPairingConnectionStatus>('connecting');
  const [tick, setTick] = useState(0);
  const participantId = pbClients.participant.authStore.model?.id;
  // 以内容生成稳定依赖键，避免调用方每次渲染传入新数组导致反复重建订阅。
  const activityKey = [...new Set(activityIds)].sort().join('|');
  // 快照按参与者归属：账号切换时清空，重试/活动列表变化时保留旧快照（陈旧标记由 error 表达）。
  const filledByRef = useRef<string | null>(null);

  useEffect(() => {
    const ids = activityKey ? activityKey.split('|') : [];
    if (ids.length === 0 || !participantId) {
      filledByRef.current = null;
      setEntries({});
      setStatus('offline');
      return;
    }
    let cancelled = false;
    let stop: (() => Promise<void>) | undefined;
    if (filledByRef.current !== participantId) {
      filledByRef.current = participantId;
      setEntries({});
    }
    setStatus('connecting');
    subscribeMyPairing({
      client: pbClients.participant,
      activityIds: ids,
      participantId,
      onSnapshot: (activityId, snapshot) => {
        if (cancelled) return;
        setEntries((prev) => ({ ...prev, [activityId]: { snapshot, error: null } }));
      },
      onError: (activityId, error) => {
        if (cancelled) return;
        setEntries((prev) => ({
          ...prev,
          [activityId]: { snapshot: prev[activityId]?.snapshot ?? null, error },
        }));
      },
      onStatusChange: (value) => {
        if (!cancelled) setStatus(value);
      },
    })
      .then((release) => {
        if (cancelled) {
          void release();
          return;
        }
        stop = release;
      })
      .catch(() => {
        // 快照拉取失败走 onError；订阅失败已降级为 offline，不会到这里。
        if (!cancelled) setStatus('offline');
      });
    return () => {
      cancelled = true;
      if (stop) void stop();
    };
  }, [activityKey, participantId, tick]);

  const loading = useMemo(() => {
    if (!participantId) return false;
    const ids = activityKey ? activityKey.split('|') : [];
    return ids.length > 0 && ids.some((id) => !(id in entries));
  }, [activityKey, entries, participantId]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { entries, status, loading, reload };
}

export interface MyPairingView {
  snapshot: MyPairingResponse | null;
  status: MyPairingConnectionStatus;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** 单活动便捷封装（签到成功页 / 活动详情页）。activityId 为空时惰性。 */
export function useMyPairing(activityId: string | null | undefined): MyPairingView {
  const ids = useMemo(() => (activityId ? [activityId] : []), [activityId]);
  const map = useMyPairingMap(ids);
  const entry = activityId ? map.entries[activityId] : undefined;
  return {
    snapshot: entry?.snapshot ?? null,
    status: map.status,
    error: entry?.error ?? null,
    loading: map.loading,
    reload: map.reload,
  };
}
