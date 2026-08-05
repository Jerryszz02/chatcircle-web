import type { ActivityRecord, ActivityStatus } from '../../../shared/api/types';

/**
 * 活动审批/下架队列逻辑（活动状态机见 PRD §4.3、database-design §5.5）。
 *
 * 超管可执行的迁移（technical-design §5.5）：
 * - pending_review → published（批准，写 activity_approvals + 审计）
 * - pending_review → rejected（驳回，原因必填，机构可查看原因后修改重提）
 * - published → taken_down（下架；不经过 activity_approvals，直接改状态并写审计）
 *
 * 表外迁移一律由服务端拒绝；此处仅做队列过滤与按钮可用性判断（体验层）。
 */

/** 待审核队列过滤（机构开启发布审核的活动提交后进入 pending_review）。 */
export function isPendingReview(activity: Pick<ActivityRecord, 'status'>): boolean {
  return activity.status === 'pending_review';
}

/** 是否可批准/驳回（仅待平台审核态）。 */
export function canReview(activity: Pick<ActivityRecord, 'status'>): boolean {
  return isPendingReview(activity);
}

/** 是否可下架（仅已发布态可下架为 taken_down，PRD §4.3）。 */
export function canUnpublish(activity: Pick<ActivityRecord, 'status'>): boolean {
  return activity.status === 'published';
}

/** 活动监管页状态筛选的 PocketBase filter 片段；空值表示不筛选。 */
export function buildActivityFilter(
  organizationId: string,
  status: ActivityStatus | '',
): string | undefined {
  const parts: string[] = [];
  if (organizationId) parts.push(`organization_id="${escapeFilterValue(organizationId)}"`);
  if (status) parts.push(`status="${escapeFilterValue(status)}"`);
  return parts.length > 0 ? parts.join(' && ') : undefined;
}

/** 驳回原因校验：必填且不能为空白（PRD §4.3「驳回必填原因」）。返回错误文案，合法返回 null。 */
export function validateRejectReason(reason: string): string | null {
  if (reason.trim() === '') {
    return '请填写驳回原因，机构将依据该原因修改后重新提交';
  }
  return null;
}

/** 转义 PocketBase filter 字符串值中的双引号。 */
export function escapeFilterValue(value: string): string {
  return value.replace(/"/g, '\\"');
}
