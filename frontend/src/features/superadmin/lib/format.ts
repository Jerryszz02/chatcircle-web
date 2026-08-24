/**
 * 展示用时间格式化（PocketBase 日期形如 "2026-08-05 02:31:55.961Z"，UTC 存储）。
 * 统一经 parsePbDate 解析后按本地时区展示（与机构管理端口径一致）；
 * 导出文件内的时间格式由服务端保证（PRD §10.3），前端只负责界面展示。
 */

import { parsePbDate } from '../../../shared/lib/datetime';

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 格式化为本地 "YYYY-MM-DD HH:mm"；空值/非法值返回占位符。 */
export function formatDateTime(value?: string | null): string {
  const d = parsePbDate(value);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 格式化为本地 "YYYY-MM-DD"；空值/非法值返回占位符。 */
export function formatDate(value?: string | null): string {
  const d = parsePbDate(value);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 取当前时间的 PocketBase 日期字符串（写库用，如模板版本 published_at）。 */
export function nowPbDateTime(): string {
  return new Date().toISOString().replace('T', ' ');
}
