import PocketBase, { ClientResponseError, LocalAuthStore } from 'pocketbase';
import type { SendOptions } from 'pocketbase';

/**
 * PocketBase 后端地址。
 * 生产部署时前端产物由 PocketBase 同源伺服（pb_public），VITE_PB_URL 留空即同源；
 * 本地开发未设置（undefined）时同样回退 window.location.origin——vite dev server
 * 已配置 /api 代理到 PocketBase（见 vite.config.ts），无需直连端口。
 * 空字符串/未设置都必须落成绝对 origin：pocketbase SDK 的 buildUrl 会把空/相对
 * baseUrl 拼到当前页面 pathname 之后（如 /login 页 → /login/api/...，全站 API 404）。
 * 跨环境直连用 VITE_PB_URL 覆盖（见 technical-design §5.7）。
 */
const envUrl = import.meta.env.VITE_PB_URL;
export const PB_URL: string = envUrl ? envUrl : window.location.origin;

/**
 * 三类角色（technical-design §5.3/§5.4）：
 * - participant：participant_accounts，全平台通用参与者（不绑机构）
 * - admin：admin_accounts，机构管理员（绑 organization_id）
 * - super：PocketBase 内置 _superusers，全平台唯一超级管理员
 */
export type Role = 'participant' | 'admin' | 'super';

/**
 * 各角色会话在 localStorage 中的存储 key。
 * 三类会话互不通用（PRD §3.2、technical-design §5.3），因此按角色隔离存储；
 * 产品层要求单会话互斥——登录任一角色成功即清除其它角色会话（见 shared/auth.ts），
 * 退出当前账号后才能登录另一个身份。
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

/** 各角色未登录时的重定向目标（technical-design §5.3 路由表；统一 401 处理同用）。 */
export const LOGIN_PATHS: Record<Role, string> = {
  participant: '/login',
  admin: '/admin/login',
  super: '/super/login',
};

/**
 * 剔除 send options 中值为 undefined 的字段（含 options.query 内的字段）。
 *
 * pocketbase SDK 0.21.x 不会跳过 undefined 查询参数，会把 filter: undefined
 * 序列化成字符串 "undefined" 发出（如 filter=undefined），服务端解析 filter
 * 报 400（invalid or incomplete filter expression）。各页面的筛选构造器
 * （如 buildActivityFilter/buildAuditFilter）在无筛选时合法地返回 undefined，
 * 因此统一在这里兜底，一处修复全局生效。
 */
function stripUndefinedParams(options: SendOptions): SendOptions {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (key === 'query' && value && typeof value === 'object') {
      cleaned.query = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined),
      );
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned as SendOptions;
}

/**
 * 管理端（admin/super）401 统一处理：会话失效（token 过期/被重置）时清除本地会话
 * 并跳转对应登录页，避免各页面把过期会话展示为普通业务错误。
 *
 * - 参与者端不在此跳转：报名/签到/问卷等页需按场景做「登出 → 登录后回跳」引导
 *   （见各页面 isUnauthorized 分支）；
 * - 认证类请求（登录、邀请码注册）的 401 是「凭据错误」的正常信号，不触发跳转，
 *   否则登录页自身的失败会陷入「401 → 跳登录页 → 再 401」死循环；
 * - 已在对应登录页时同样不跳转（页内后台请求失败由页面自行展示）。
 */
function handleSessionExpired(role: Role, client: PocketBase, path: string, err: unknown): void {
  if (role === 'participant') return;
  if (!(err instanceof ClientResponseError) || err.status !== 401 || err.isAbort) return;
  if (path.includes('/auth-with-password') || path.startsWith('/api/cc/auth/')) return;
  const loginPath = LOGIN_PATHS[role];
  if (typeof window !== 'undefined' && window.location.pathname === loginPath) return;
  client.authStore.clear();
  window.location.replace(loginPath);
}

function createClient(role: Role): PocketBase {
  const client = new PocketBase(PB_URL, new LocalAuthStore(AUTH_STORAGE_KEYS[role]));
  // 关闭 SDK 默认的 autoCancellation：React StrictMode / 组件重渲染下同一 URL 的
  // 重复请求会互相取消，取消被 UI 误报为「请求已取消」失败（看板失败计数同理）。
  // 各页面请求均为幂等 GET，重复发出无副作用。
  client.autoCancellation(false);
  const rawSend = client.send.bind(client);
  client.send = <T,>(path: string, options: SendOptions = {}): Promise<T> =>
    rawSend<T>(path, stripUndefinedParams(options)).catch((err: unknown) => {
      handleSessionExpired(role, client, path, err);
      throw err;
    });
  return client;
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
