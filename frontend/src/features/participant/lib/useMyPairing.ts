import { useCallback, useEffect, useState } from 'react';
import type { MyPairingResponse } from '../../../shared/api/accountEvent';
import { normalizeApiError, type ApiError } from '../../../shared/api/http';
import { pbClients } from '../../../shared/pocketbase';
import {
  subscribeMyPairing,
  type MyPairingConnectionStatus,
} from './myPairingLive';

/**
 * 本人配对状态 hook（T5）：先订阅本人 Realtime 失效事件，再拉取 my-pairing 快照；
 * 事件/断线恢复均触发重拉。activityId 为空或未登录时惰性（不发请求、不订阅）。
 */
export interface MyPairingView {
  snapshot: MyPairingResponse | null;
  status: MyPairingConnectionStatus;
  error: ApiError | null;
  loading: boolean;
  /** 手动重试：整体重建订阅并重拉快照。 */
  reload: () => void;
}

export function useMyPairing(activityId: string | null | undefined): MyPairingView {
  const [snapshot, setSnapshot] = useState<MyPairingResponse | null>(null);
  const [status, setStatus] = useState<MyPairingConnectionStatus>('connecting');
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const participantId = pbClients.participant.authStore.model?.id;

  useEffect(() => {
    if (!activityId || !participantId) {
      setSnapshot(null);
      setError(null);
      setLoading(false);
      setStatus('offline');
      return;
    }
    let cancelled = false;
    let stop: (() => Promise<void>) | undefined;
    setLoading(true);
    setError(null);
    setStatus('connecting');
    subscribeMyPairing({
      client: pbClients.participant,
      activityId,
      participantId,
      onSnapshot: (value) => {
        if (cancelled) return;
        setSnapshot(value);
        setError(null);
        setLoading(false);
      },
      onStatusChange: (value) => {
        if (!cancelled) setStatus(value);
      },
      onError: (value) => {
        if (!cancelled) setError(value);
      },
    })
      .then((release) => {
        if (cancelled) {
          void release();
          return;
        }
        stop = release;
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(normalizeApiError(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      if (stop) void stop();
    };
  }, [activityId, participantId, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { snapshot, status, error, loading, reload };
}
