import { describe, expect, it } from 'vitest';
import type { AdminInviteRecord, InviteStatus } from '../../../shared/api/types';
import { INVITE_STATUS_LABELS } from './labels';
import {
  canRevokeInvite,
  effectiveInviteStatus,
  filterInvitesByStatus,
  inviteStatusLabel,
} from './inviteStatus';

/** 构造最小邀请码（仅状态展示逻辑关心的字段）。 */
function makeInvite(status: InviteStatus, expiresAt: string): AdminInviteRecord {
  return {
    id: `inv_${status}_${expiresAt}`,
    created: '2026-08-01 00:00:00.000Z',
    updated: '2026-08-01 00:00:00.000Z',
    organization_id: 'org1',
    token_hash: 'hash',
    status,
    expires_at: expiresAt,
    created_by: 'super1',
  };
}

const NOW = new Date('2026-08-05T00:00:00.000Z');
const FUTURE = '2026-08-10 00:00:00.000Z';
const PAST = '2026-08-01 00:00:00.000Z';

describe('邀请码四态展示（PRD §4.2、FR-ORG-002）', () => {
  it('未使用且未过期 → 未使用', () => {
    expect(effectiveInviteStatus(makeInvite('unused', FUTURE), NOW)).toBe('unused');
    expect(inviteStatusLabel(makeInvite('unused', FUTURE), NOW)).toBe('未使用');
  });

  it('未使用但已过有效期 → 展示为已过期（派生态，服务端未回写也正确展示）', () => {
    expect(effectiveInviteStatus(makeInvite('unused', PAST), NOW)).toBe('expired');
    expect(inviteStatusLabel(makeInvite('unused', PAST), NOW)).toBe('已过期');
  });

  it('已使用/已撤销/已过期存储态原样展示，不受有效期影响', () => {
    expect(effectiveInviteStatus(makeInvite('used', FUTURE), NOW)).toBe('used');
    expect(effectiveInviteStatus(makeInvite('revoked', FUTURE), NOW)).toBe('revoked');
    expect(effectiveInviteStatus(makeInvite('expired', FUTURE), NOW)).toBe('expired');
  });

  it('兼容 ISO（T 分隔）与 PocketBase（空格分隔）两种时间格式', () => {
    expect(effectiveInviteStatus(makeInvite('unused', '2026-08-10T00:00:00.000Z'), NOW)).toBe(
      'unused',
    );
    expect(effectiveInviteStatus(makeInvite('unused', '2026-08-01T00:00:00.000Z'), NOW)).toBe(
      'expired',
    );
  });

  it('四态标签齐全（未使用/已使用/已撤销/已过期）', () => {
    expect(Object.keys(INVITE_STATUS_LABELS).sort()).toEqual(
      ['expired', 'revoked', 'unused', 'used'].sort(),
    );
    expect(INVITE_STATUS_LABELS.unused).toBe('未使用');
    expect(INVITE_STATUS_LABELS.used).toBe('已使用');
    expect(INVITE_STATUS_LABELS.revoked).toBe('已撤销');
    expect(INVITE_STATUS_LABELS.expired).toBe('已过期');
  });

  it('仅未使用且未过期可撤销', () => {
    expect(canRevokeInvite(makeInvite('unused', FUTURE), NOW)).toBe(true);
    expect(canRevokeInvite(makeInvite('unused', PAST), NOW)).toBe(false);
    expect(canRevokeInvite(makeInvite('used', FUTURE), NOW)).toBe(false);
    expect(canRevokeInvite(makeInvite('revoked', FUTURE), NOW)).toBe(false);
  });

  it('按展示态过滤列表：过期筛选命中派生过期项', () => {
    const invites = [
      makeInvite('unused', FUTURE),
      makeInvite('unused', PAST),
      makeInvite('used', FUTURE),
      makeInvite('revoked', PAST),
    ];
    expect(filterInvitesByStatus(invites, '', NOW)).toHaveLength(4);
    expect(filterInvitesByStatus(invites, 'unused', NOW)).toHaveLength(1);
    expect(filterInvitesByStatus(invites, 'expired', NOW)).toHaveLength(1);
    expect(filterInvitesByStatus(invites, 'used', NOW)).toHaveLength(1);
    expect(filterInvitesByStatus(invites, 'revoked', NOW)).toHaveLength(1);
  });
});
