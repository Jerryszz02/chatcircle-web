import { describe, expect, it } from 'vitest';
import { isCurrentActivity, isPastActivity } from './activitySplit';

/**
 * 现有/往期划分单测：closed 或 end_time 已过即往期。
 * 回归场景：已结束但机构未手动关闭的活动（status 仍是 published，
 * 如 2026-06-12 凯德专场）不得残留在现有活动列表。
 * 测试数据均为 PocketBase 日期格式（'YYYY-MM-DD HH:mm:ss.sssZ'）。
 */

const NOW = new Date('2026-08-26T02:00:00.000Z');

describe('isPastActivity / isCurrentActivity 现有/往期划分', () => {
  it('closed 状态一律算往期（不论 end_time）', () => {
    expect(isPastActivity({ status: 'closed', end_time: '2099-01-01 00:00:00.000Z' }, NOW)).toBe(
      true,
    );
  });

  it('published 且 end_time 已过：算往期（凯德专场回归：已结束未手动关闭）', () => {
    expect(isPastActivity({ status: 'published', end_time: '2026-06-12 08:30:00.000Z' }, NOW)).toBe(
      true,
    );
    expect(
      isCurrentActivity({ status: 'published', end_time: '2026-06-12 08:30:00.000Z' }, NOW),
    ).toBe(false);
  });

  it('published 且 end_time 未到：算现有', () => {
    expect(isPastActivity({ status: 'published', end_time: '2026-09-01 10:00:00.000Z' }, NOW)).toBe(
      false,
    );
    expect(
      isCurrentActivity({ status: 'published', end_time: '2026-09-01 10:00:00.000Z' }, NOW),
    ).toBe(true);
  });

  it('end_time 恰好等于当前时刻：不算已过（结束后才归入往期）', () => {
    expect(isPastActivity({ status: 'published', end_time: '2026-08-26 02:00:00.000Z' }, NOW)).toBe(
      false,
    );
  });

  it('end_time 无法解析时不隐匿活动，按现有处理', () => {
    expect(isPastActivity({ status: 'published', end_time: '' }, NOW)).toBe(false);
  });
});
