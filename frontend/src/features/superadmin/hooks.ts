import { useCallback, useContext, useEffect, useState } from 'react';
import {
  ToastContext,
  type ToastContextValue,
} from '../../shared/ui/toast-context';
import { fetchBackupStatus } from './api';
import type { BackupStatus } from './lib/backup';

/**
 * 超管端 Toast 通道。
 * 生产环境 main.tsx 已挂载全局 ToastProvider；路由级裸渲染（如 router.test）
 * 没有 Provider 时降级为 console 输出，保证页面可独立渲染、不阻断交互。
 */
export function useSuperToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  return {
    toast: (message, kind = 'info') => {
      const log = kind === 'error' ? console.error : console.info;
      log(`[toast:${kind}] ${message}`);
    },
  };
}

/**
 * 备份状态 hook（/super/system 状态卡与全局看板告警位共用，technical-design §5.8）。
 * 失败时 alarm=true，页面渲染显著告警横幅（AC-23）。
 */
export function useBackupStatus() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchBackupStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : '备份状态加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await fetchBackupStatus();
        if (!cancelled) setStatus(s);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '备份状态加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { status, loading, error, refresh };
}
