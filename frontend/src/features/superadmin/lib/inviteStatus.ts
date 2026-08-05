import type { AdminInviteRecord, InviteStatus } from '../../../shared/api/types';
import { INVITE_STATUS_LABELS } from './labels';

/**
 * 邀请码四态展示逻辑（PRD §4.2、database-design §5.5）。
 *
 * 存储态为 unused/used/revoked/expired；但「过期」可能由时间自然到达而服务端尚未回写，
 * 因此展示态以 effectiveInviteStatus 为准：status=unused 且 expires_at 已过 → 已过期。
 * 撤销、使用以存储状态为准（服务端在事务内回写，见 technical-design §5.4）。
 */

/** 计算邀请码的展示态（now 默认当前时间，测试可注入）。 */
export function effectiveInviteStatus(
  invite: Pick<AdminInviteRecord, 'status' | 'expires_at'>,
  now: Date = new Date(),
): InviteStatus {
  if (invite.status === 'unused' && new Date(invite.expires_at.replace(' ', 'T')) < now) {
    return 'expired';
  }
  return invite.status;
}

/** 展示态中文标签。 */
export function inviteStatusLabel(
  invite: Pick<AdminInviteRecord, 'status' | 'expires_at'>,
  now: Date = new Date(),
): string {
  return INVITE_STATUS_LABELS[effectiveInviteStatus(invite, now)];
}

/** 是否仍可撤销（仅未使用且未过期的邀请码可撤销，FR-ORG-002）。 */
export function canRevokeInvite(
  invite: Pick<AdminInviteRecord, 'status' | 'expires_at'>,
  now: Date = new Date(),
): boolean {
  return effectiveInviteStatus(invite, now) === 'unused';
}

/** 列表页状态筛选选项（含「全部」）。 */
export const INVITE_FILTER_OPTIONS: readonly { value: InviteStatus | ''; label: string }[] = [
  { value: '', label: '全部状态' },
  { value: 'unused', label: INVITE_STATUS_LABELS.unused },
  { value: 'used', label: INVITE_STATUS_LABELS.used },
  { value: 'revoked', label: INVITE_STATUS_LABELS.revoked },
  { value: 'expired', label: INVITE_STATUS_LABELS.expired },
];

/** 前端按展示态过滤（过期为派生态，需用 effectiveInviteStatus 判定）。泛型保留调用方的 expand 类型。 */
export function filterInvitesByStatus<T extends AdminInviteRecord>(
  invites: readonly T[],
  status: InviteStatus | '',
  now: Date = new Date(),
): T[] {
  if (!status) return [...invites];
  return invites.filter((inv) => effectiveInviteStatus(inv, now) === status);
}
