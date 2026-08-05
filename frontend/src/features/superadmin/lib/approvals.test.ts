import { describe, expect, it } from 'vitest';
import type { ActivityStatus } from '../../../shared/api/types';
import {
  buildActivityFilter,
  canReview,
  canUnpublish,
  escapeFilterValue,
  isPendingReview,
  validateRejectReason,
} from './approvals';

function act(status: ActivityStatus) {
  return { status };
}

const ALL_STATUSES: ActivityStatus[] = [
  'draft',
  'pending_review',
  'rejected',
  'published',
  'closed',
  'taken_down',
  'archived',
];

describe('审核队列逻辑（PRD §4.3 活动状态机）', () => {
  it('仅 pending_review 进入待审核队列、可批准/驳回', () => {
    for (const status of ALL_STATUSES) {
      expect(isPendingReview(act(status))).toBe(status === 'pending_review');
      expect(canReview(act(status))).toBe(status === 'pending_review');
    }
  });

  it('仅 published 可下架（published → taken_down）', () => {
    for (const status of ALL_STATUSES) {
      expect(canUnpublish(act(status))).toBe(status === 'published');
    }
  });

  it('驳回原因必填：空串与纯空白均拒绝', () => {
    expect(validateRejectReason('')).not.toBeNull();
    expect(validateRejectReason('   ')).not.toBeNull();
    expect(validateRejectReason('\n\t')).not.toBeNull();
  });

  it('驳回原因合法：非空文本通过', () => {
    expect(validateRejectReason('活动信息与备案不符，请修改后重新提交')).toBeNull();
  });

  it('活动监管筛选：机构与状态组合为 PocketBase filter', () => {
    expect(buildActivityFilter('', '')).toBeUndefined();
    expect(buildActivityFilter('org1', '')).toBe('organization_id="org1"');
    expect(buildActivityFilter('', 'published')).toBe('status="published"');
    expect(buildActivityFilter('org1', 'published')).toBe(
      'organization_id="org1" && status="published"',
    );
  });

  it('filter 值转义双引号，防止注入', () => {
    expect(escapeFilterValue('a"b')).toBe('a\\"b');
    expect(buildActivityFilter('or"g1', '')).toBe('organization_id="or\\"g1"');
  });
});
