/**
 * 展示用时间格式化（PocketBase 日期形如 "2026-08-05 02:31:55.961Z"）。
 * 仅做截断展示，不做时区换算——导出与审计口径以服务端 ISO 8601 带时区为准（PRD §10.3）。
 */

/** 格式化为 "YYYY-MM-DD HH:mm"；空值返回占位符。 */
export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  // 兼容 "YYYY-MM-DD HH:mm:ss" 与 ISO "YYYY-MM-DDTHH:mm:ss" 两种形态
  const normalized = value.replace('T', ' ');
  return normalized.slice(0, 16);
}

/** 格式化为 "YYYY-MM-DD"；空值返回占位符。 */
export function formatDate(value?: string | null): string {
  if (!value) return '—';
  return value.slice(0, 10);
}

/** 取当前时间的 PocketBase 日期字符串（写库用，如模板版本 published_at）。 */
export function nowPbDateTime(): string {
  return new Date().toISOString().replace('T', ' ');
}
