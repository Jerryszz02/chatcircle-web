/**
 * 跨端共享的日期时间工具。
 *
 * PocketBase date 字段返回形如 `2026-08-05 02:31:55.947Z`（空格分隔 + UTC），
 * 统一经 parsePbDate 解析后再格式化；筛选条件里的日期边界同样以 UTC 口径下发。
 */

/** 解析 PocketBase 日期字符串；空值/非法值返回 null。 */
export function parsePbDate(value?: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date → PocketBase 日期字符串（`YYYY-MM-DD HH:mm:ss.SSSZ`，UTC）。 */
export function toPbDateTimeUtc(d: Date): string {
  return d.toISOString().replace('T', ' ');
}

/**
 * `<input type=date>` 的本地日期（`YYYY-MM-DD`）→ 该本地自然日对应的 UTC 起止边界
 *（PocketBase 日期字符串，左闭右开）。
 *
 * 例（Asia/Shanghai，UTC+8）：本地 2026-08-07 →
 *   gte = `2026-08-06 16:00:00.000Z`，lt = `2026-08-07 16:00:00.000Z`。
 * PB 的 created/start_time 等字段按 UTC 存储与比较，直接把本地日期拼 `00:00:00`
 * 会被当作 UTC 边界，筛选结果整体偏移一个时区。非法输入返回 null。
 */
export function localDayToPbUtcRange(date: string): { gte: string; lt: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // 本地时区构造当日起点；构造函数会进位非法日期（如 02-31），逐项校验拒绝
  const start = new Date(year, month - 1, day);
  if (
    Number.isNaN(start.getTime()) ||
    start.getFullYear() !== year ||
    start.getMonth() !== month - 1 ||
    start.getDate() !== day
  ) {
    return null;
  }
  const end = new Date(year, month - 1, day + 1);
  return { gte: toPbDateTimeUtc(start), lt: toPbDateTimeUtc(end) };
}
