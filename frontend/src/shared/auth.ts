import type PocketBase from 'pocketbase';
import type { AuthModel } from 'pocketbase';
import { apiPost } from './api/http';
import type { BindPhoneResponse, ParticipantPhoneAuthResponse } from './api/accountEvent';
import { pbClients, pbForRole, ROLE_COLLECTIONS, type Role } from './pocketbase';

/**
 * 三类角色的认证封装（technical-design §5.4、FR-AUTH-001~009）。
 *
 * - 参与者 participant_accounts：T1 新账号统一走手机号验证码；
 *   `POST /api/cc/auth/participant` 仅供存量用户名账号校验密码并进入绑定流程，
 *   未知用户名不得创建账号或签发 token（AC-06）。
 * - 管理员 admin_accounts：标准 authWithPassword 登录；注册走一次性邀请码端点
 *   `POST /api/cc/auth/admin-register`（FR-ORG-002，由管理端注册页调用 api 层）。
 * - 超级管理员 _superusers：标准 authWithPassword 登录；初始部署时创建，无产品注册入口。
 *
 * token 持久化由各角色独立 LocalAuthStore 完成（见 shared/pocketbase.ts），
 * 参与者 token 有效期 30 天由服务端 collection 配置保证（FR-AUTH-006），前端不处理续期。
 *
 * 单会话互斥：同一浏览器任一时刻只持有一个有效会话。登录任一角色成功即
 * 清除其它两个角色的会话（makeRoleAuth 统一保证，覆盖手机号登录、存量迁移、
 * 邀请码注册后自动登录等全部入口）；要登录另一个身份必须先退出当前账号。
 */

/** 参与者自定义认证端点的响应形态（约定与 PocketBase auth 响应一致：token + record）。 */
export interface ParticipantAuthResponse {
  token: string;
  record: AuthModel;
}

/** 单角色会话的操作接口。 */
export interface RoleAuth {
  /** 所属角色。 */
  readonly role: Role;
  /** 该角色对应的 PocketBase client（含独立 authStore）。 */
  readonly client: PocketBase;
  /** 登录成功后将 token + record 写入本角色的持久化 authStore。 */
  login(identity: string, password: string): Promise<AuthModel>;
  /** 主动退出：仅清除本地会话，服务端 token 自然过期（FR-AUTH-006、§12.4）。 */
  logout(): void;
  /** 当前是否持有有效（未过期）的本角色会话。 */
  isValid(): boolean;
  /** 当前登录记录（未登录为 null）。 */
  readonly record: AuthModel | null;
  /** 当前 token（未登录为空字符串）。 */
  readonly token: string;
}

function makeRoleAuth(role: Role, login: RoleAuth['login']): RoleAuth {
  const client = pbClients[role];
  return {
    role,
    client,
    async login(identity, password) {
      const record = await login(identity, password);
      // 单会话互斥：本角色登录成功即清除其它角色会话，
      // 保证任一时刻全端只有一个有效会话（无论从哪个入口登录）。
      for (const other of Object.keys(pbClients) as Role[]) {
        if (other !== role) pbClients[other].authStore.clear();
      }
      return record;
    },
    logout() {
      client.authStore.clear();
    },
    isValid() {
      return client.authStore.isValid;
    },
    get record() {
      return client.authStore.model;
    },
    get token() {
      return client.authStore.token;
    },
  };
}

function clearOtherRoleSessions(role: Role): void {
  for (const other of Object.keys(pbClients) as Role[]) {
    if (other !== role) pbClients[other].authStore.clear();
  }
}

/** 参与者：仅登录存量用户名账号；未知用户名由服务端统一拒绝。 */
export const participantAuth: RoleAuth = makeRoleAuth('participant', async (username, password) => {
  const res = await apiPost<ParticipantAuthResponse>(
    pbClients.participant,
    '/api/cc/auth/participant',
    {
      username,
      password,
    },
  );
  pbClients.participant.authStore.save(res.token, res.record);
  return res.record;
});

/**
 * 手机号验证码认证成功后接管参与者会话。响应是 T0 白名单账号形状，不含内部
 * username/password/phone_e164/phone_lookup_hash。
 */
export function saveParticipantPhoneAuth(response: ParticipantPhoneAuthResponse): AuthModel {
  clearOtherRoleSessions('participant');
  const record = response.record as AuthModel;
  pbClients.participant.authStore.save(response.token, record);
  return record;
}

/** 绑定/换绑成功后把公开手机号状态合并进当前持久化会话，刷新后仍可展示掩码。 */
export function updateParticipantPhoneSession(response: BindPhoneResponse): void {
  const current = pbClients.participant.authStore.model;
  const token = pbClients.participant.authStore.token;
  if (!current || !token || current.id !== response.participant_id) return;
  pbClients.participant.authStore.save(token, {
    ...current,
    phone_masked: response.phone_masked,
    phone_verified_at: response.phone_verified_at,
    phone_migration_status: response.phone_migration_status,
  } as AuthModel);
}

/** 机构管理员：用户名 + 密码登录（邀请码注册见 api 层 auth/registerAdmin）。
 *  用户名存储统一小写（后端 auth.pb.js 注册时小写归一化），登录输入同样小写化再提交。 */
export const adminAuth: RoleAuth = makeRoleAuth('admin', async (username, password) => {
  const res = await pbClients.admin
    .collection(ROLE_COLLECTIONS.admin)
    .authWithPassword(username.trim().toLowerCase(), password);
  return res.record;
});

/** 超级管理员：PocketBase _superusers 登录（FR-AUTH-009）。 */
export const superAuth: RoleAuth = makeRoleAuth('super', async (identity, password) => {
  const res = await pbClients.super
    .collection(ROLE_COLLECTIONS.super)
    .authWithPassword(identity, password);
  return res.record;
});

/** 各角色未登录时的重定向目标：定义在 pocketbase.ts（401 统一处理同用，避免循环依赖），此处再导出保持既有引用不变。 */
export { LOGIN_PATHS } from './pocketbase';

/** 按角色取认证封装。 */
export function authFor(role: Role): RoleAuth {
  switch (role) {
    case 'participant':
      return participantAuth;
    case 'admin':
      return adminAuth;
    case 'super':
      return superAuth;
  }
}

/** 当前持有有效会话的角色。登录互斥（见 makeRoleAuth）下至多一个会话有效；
 *  异常情况下多会话并存时按 participant → admin → super 顺序返回首个。 */
export function currentRole(): Role | null {
  for (const role of ['participant', 'admin', 'super'] as const) {
    if (pbForRole(role).authStore.isValid) return role;
  }
  return null;
}

/** 指定角色是否已登录。 */
export function hasRole(role: Role): boolean {
  return authFor(role).isValid();
}

/** 是否有任意角色的有效会话（守卫用于区分「未登录」与「角色不符」）。 */
export function hasAnySession(): boolean {
  return currentRole() !== null;
}
