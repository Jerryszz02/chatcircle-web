import PocketBase, { LocalAuthStore } from 'pocketbase';

/**
 * PocketBase 后端地址。
 * 生产部署时前端产物由 PocketBase 同源伺服（pb_public），通常无需设置；
 * 本地开发直连默认 8090 端口（vite dev server 亦配置了 /api 代理，见 vite.config.ts），
 * 跨环境直连用 VITE_PB_URL 覆盖（见 technical-design §5.7）。
 */
export const PB_URL: string = import.meta.env.VITE_PB_URL ?? 'http://127.0.0.1:8090';

/**
 * 三类角色（technical-design §5.3/§5.4）：
 * - participant：participant_accounts，全平台通用参与者（不绑机构）
 * - admin：admin_accounts，机构管理员（绑 organization_id）
 * - super：PocketBase 内置 _superusers，全平台唯一超级管理员
 */
export type Role = 'participant' | 'admin' | 'super';

/**
 * 各角色会话在 localStorage 中的存储 key。
 * 三类会话互不通用（PRD §3.2、technical-design §5.3），因此按角色隔离存储，
 * 同一浏览器可同时持有三种会话而互不覆盖。
 */
export const AUTH_STORAGE_KEYS: Record<Role, string> = {
  participant: 'cc_participant_auth',
  admin: 'cc_admin_auth',
  super: 'cc_super_auth',
};

/** 角色对应的 PocketBase auth collection 名（database-design §5.2）。 */
export const ROLE_COLLECTIONS: Record<Role, string> = {
  participant: 'participant_accounts',
  admin: 'admin_accounts',
  super: '_superusers',
};

function createClient(role: Role): PocketBase {
  return new PocketBase(PB_URL, new LocalAuthStore(AUTH_STORAGE_KEYS[role]));
}

/**
 * 按角色独立的 PocketBase client；每个 client 持有自己的 authStore，
 * token 持久化到各自 storage key，互不干扰（technical-design §5.4 会话模型）。
 */
export const pbClients: Record<Role, PocketBase> = {
  participant: createClient('participant'),
  admin: createClient('admin'),
  super: createClient('super'),
};

/** 取某角色的 PocketBase client。 */
export function pbForRole(role: Role): PocketBase {
  return pbClients[role];
}

/**
 * 默认 client = 参与者端（兼容既有引用）。
 * 业务代码应按实际角色使用 pbForRole(role) 或 shared/auth 的角色封装。
 */
export const pb = pbClients.participant;
