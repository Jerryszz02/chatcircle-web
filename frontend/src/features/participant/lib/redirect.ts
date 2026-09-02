/**
 * /login 的 redirect 回跳参数处理（FR-AUTH-008、AC-22）。
 * 仅允许站内相对路径，防止开放重定向（CWE-601）；回跳目标是登录页本身时视为无效（避免循环）。
 *
 * 加固要点（安全审查 finding 1/3，2026-09）：
 * - 拒绝反斜杠与控制字符：如 `/\\evil.example` 能绕过 startsWith('/')，但被浏览器/React Router
 *   规范化成 `//evil.example`（协议相对）而跳出站外；控制字符/NUL 同理被规范化。
 * - 解析后确认真实 origin 未变：对通过前缀检查的入参用 `new URL(raw, base)` 解析，
 *   校验解析结果的 origin 与当前站一致，防「看似站内、解析后站外」的绕过。
 */
export function sanitizeRedirect(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // 反斜杠、控制字符、NUL：规范化会把它变成可跳出站外的形态（协议相对 / 站外主机）。
  // eslint 的 no-control-regex 会告警，这里是刻意拒绝控制字符（CWE-601 防御），故豁免。
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  // 解析后再确认真实 origin 未变（非浏览器环境（如单测）兜底为本地原点）
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    if (new URL(raw, base).origin !== base) return null;
  } catch {
    return null;
  }
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login#')) return null;
  return raw;
}
