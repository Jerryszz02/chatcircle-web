import type { PublicActivityListItem } from '../api';

/**
 * 现有/往期活动划分（首页与活动列表页统一口径）。
 * 「往期」= 状态已关闭（closed），或结束时间已过（end_time 早于当前时间）。
 * 不能只看 status：published → closed 需机构管理员手动操作，
 * 「已结束但未手动关闭」的活动 status 仍是 published，仅凭 status 过滤
 * 会让它残留在现有活动列表（如 2026-06-12 凯德专场）。
 * PocketBase 日期为空格分隔（'YYYY-MM-DD HH:mm:ss.sssZ'），
 * 解析前替换为 'T'（同 lib/status.ts 的 formatDateTime）。
 */
export function isPastActivity(
  activity: Pick<PublicActivityListItem, 'status' | 'end_time'>,
  now: Date = new Date(),
): boolean {
  if (activity.status === 'closed') return true;
  const end = new Date(activity.end_time.replace(' ', 'T'));
  // 时间无法解析时不隐匿活动，按未结束处理
  return !Number.isNaN(end.getTime()) && end.getTime() < now.getTime();
}

export function isCurrentActivity(
  activity: Pick<PublicActivityListItem, 'status' | 'end_time'>,
  now: Date = new Date(),
): boolean {
  return !isPastActivity(activity, now);
}
