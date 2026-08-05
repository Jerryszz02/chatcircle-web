import { beforeEach, describe, expect, it } from 'vitest';
import PocketBase, { LocalAuthStore } from 'pocketbase';
import {
  adminAuth,
  authFor,
  currentRole,
  hasAnySession,
  hasRole,
  participantAuth,
  superAuth,
} from './auth';
import { AUTH_STORAGE_KEYS, PB_URL, pbClients } from './pocketbase';

/** 构造一个未过期的假 JWT（结构满足 SDK 的过期解析即可，签名不校验）。 */
function makeToken(expOffsetSeconds = 3600): string {
  const b64 = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    exp: Math.floor(Date.now() / 1000) + expOffsetSeconds,
    id: 'test_record_id',
    type: 'authRecord',
    collectionId: 'test_collection',
  });
  return `${header}.${payload}.fake-signature`;
}

function saveSession(role: keyof typeof pbClients, collectionName: string) {
  pbClients[role].authStore.save(makeToken(), {
    id: `${role}_id`,
    collectionName,
  } as never);
}

beforeEach(() => {
  localStorage.clear();
  Object.values(pbClients).forEach((c) => c.authStore.clear());
});

describe('三角色 auth store（technical-design §5.4）', () => {
  it('三角色使用互相隔离的 localStorage 存储 key', () => {
    expect(AUTH_STORAGE_KEYS.participant).not.toBe(AUTH_STORAGE_KEYS.admin);
    expect(AUTH_STORAGE_KEYS.admin).not.toBe(AUTH_STORAGE_KEYS.super);
    expect(AUTH_STORAGE_KEYS.participant).not.toBe(AUTH_STORAGE_KEYS.super);
  });

  it('会话按角色隔离：参与者登录不影响管理与超管会话', () => {
    saveSession('participant', 'participant_accounts');
    expect(participantAuth.isValid()).toBe(true);
    expect(adminAuth.isValid()).toBe(false);
    expect(superAuth.isValid()).toBe(false);
    expect(localStorage.getItem(AUTH_STORAGE_KEYS.participant)).not.toBeNull();
    expect(localStorage.getItem(AUTH_STORAGE_KEYS.admin)).toBeNull();
    expect(localStorage.getItem(AUTH_STORAGE_KEYS.super)).toBeNull();
  });

  it('token 持久化：新 client 用同一存储 key 可恢复会话', () => {
    saveSession('admin', 'admin_accounts');
    const restored = new PocketBase(PB_URL, new LocalAuthStore(AUTH_STORAGE_KEYS.admin));
    expect(restored.authStore.isValid).toBe(true);
    expect(restored.authStore.model?.collectionName).toBe('admin_accounts');
  });

  it('过期 token 视为未登录', () => {
    pbClients.participant.authStore.save(makeToken(-60), {
      id: 'p',
      collectionName: 'participant_accounts',
    } as never);
    expect(participantAuth.isValid()).toBe(false);
  });

  it('logout 仅清除本角色会话，其它角色不受影响', () => {
    saveSession('participant', 'participant_accounts');
    saveSession('admin', 'admin_accounts');
    participantAuth.logout();
    expect(participantAuth.isValid()).toBe(false);
    expect(adminAuth.isValid()).toBe(true);
    expect(localStorage.getItem(AUTH_STORAGE_KEYS.participant)).toBeNull();
    expect(localStorage.getItem(AUTH_STORAGE_KEYS.admin)).not.toBeNull();
  });

  it('currentRole 按 authStore 记录的 collection 名判定角色', () => {
    expect(currentRole()).toBeNull();
    expect(hasAnySession()).toBe(false);

    saveSession('super', '_superusers');
    expect(currentRole()).toBe('super');
    expect(hasRole('super')).toBe(true);

    saveSession('admin', 'admin_accounts');
    // admin 优先级高于 super（participant → admin → super 取首个有效会话）
    expect(currentRole()).toBe('admin');
    expect(hasAnySession()).toBe(true);
  });

  it('authFor 返回对应角色的封装', () => {
    expect(authFor('participant')).toBe(participantAuth);
    expect(authFor('admin')).toBe(adminAuth);
    expect(authFor('super')).toBe(superAuth);
  });
});
