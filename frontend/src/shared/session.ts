import { useSyncExternalStore } from 'react';
import { pbClients } from './pocketbase';

/**
 * 订阅三个角色 authStore 的变化，使组件在登录/登出后自动重渲染。
 * 路由守卫（guards.tsx）与「按会话状态切换展示」的公共组件
 * （如 HeaderActions、报名/活动页）共用。
 */
export function useSessionSnapshot(): string {
  return useSyncExternalStore(
    (onStoreChange) => {
      const unsubs = Object.values(pbClients).map((c) => c.authStore.onChange(onStoreChange));
      return () => unsubs.forEach((unsub) => unsub());
    },
    () =>
      (['participant', 'admin', 'super'] as const)
        .map((r) => `${r}:${pbClients[r].authStore.isValid ? 1 : 0}`)
        .join(','),
  );
}
