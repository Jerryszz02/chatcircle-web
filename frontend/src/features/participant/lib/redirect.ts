/**
 * /login 的 redirect 回跳参数处理（FR-AUTH-008、AC-22）。
 * 仅允许站内相对路径，防止开放重定向；回跳目标是登录页本身时视为无效（避免循环）。
 */
export function sanitizeRedirect(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login#')) return null;
  return raw;
}
