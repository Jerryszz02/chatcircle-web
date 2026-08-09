/**
 * 时间格式化工具（机构管理端展示用）。
 *
 * PocketBase date 字段返回形如 `2026-08-05 02:31:55.947Z`（空格分隔 + UTC），
 * 统一经 parsePbDate 解析后再格式化；导出文件内的时间格式由服务端保证（PRD §10.3），
 * 前端只负责界面展示。parsePbDate 与筛选边界工具见 shared/lib/datetime。
 */

import { parsePbDate } from '../../../shared/lib/datetime';

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 格式化为本地 `YYYY-MM-DD HH:mm`；空值返回占位符。 */
export function formatDateTime(value?: string | null): string {
  const d = parsePbDate(value);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 格式化为本地 `YYYY-MM-DD`。 */
export function formatDate(value?: string | null): string {
  const d = parsePbDate(value);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** PB 日期 → datetime-local 输入框值（本地时区，`YYYY-MM-DDTHH:mm`）。 */
export function toInputDateTime(value?: string | null): string {
  const d = parsePbDate(value);
  if (!d) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local 输入框值 → 提交给后端的 ISO 字符串；空字符串返回 undefined（字段置空）。 */
export function fromInputDateTime(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** 截断展示长 id（完整值放 title 提示）。 */
export function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}
