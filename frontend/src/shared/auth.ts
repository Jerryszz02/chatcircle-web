import { pb } from './pocketbase';

/**
 * 三类会话（participant_accounts / admin_accounts / PocketBase _superusers）互不通用。
 * 占位实现：M0 仅按 authStore 中记录的 collection 名判定角色；
 * 认证端点（/api/cc/auth/*）落地后在此补齐会话初始化与恢复逻辑（technical-design §5.4）。
 */
export type Role = 'participant' | 'admin' | 'super';

export function currentRole(): Role | null {
  if (!pb.authStore.isValid) return null;
  const collection = pb.authStore.model?.collectionName;
  switch (collection) {
    case 'participant_accounts':
      return 'participant';
    case 'admin_accounts':
      return 'admin';
    case '_superusers':
      return 'super';
    default:
      return null;
  }
}

export function isLoggedIn(): boolean {
  return pb.authStore.isValid;
}

export function logout(): void {
  pb.authStore.clear();
}
