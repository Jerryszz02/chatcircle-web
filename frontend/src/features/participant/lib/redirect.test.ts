import { describe, expect, it } from 'vitest';
import { sanitizeRedirect } from './redirect';

/** /login redirect 回跳参数（FR-AUTH-008、AC-22）：仅站内相对路径，防开放重定向与循环。 */
describe('sanitizeRedirect', () => {
  it('接受站内路径', () => {
    expect(sanitizeRedirect('/me')).toBe('/me');
    expect(sanitizeRedirect('/a/act1/register')).toBe('/a/act1/register');
    expect(sanitizeRedirect('/survey/tok_1?from=qr')).toBe('/survey/tok_1?from=qr');
  });

  it('拒绝站外与非法值', () => {
    expect(sanitizeRedirect(null)).toBeNull();
    expect(sanitizeRedirect('')).toBeNull();
    expect(sanitizeRedirect('https://evil.example.com')).toBeNull();
    expect(sanitizeRedirect('//evil.example.com')).toBeNull();
    expect(sanitizeRedirect('me')).toBeNull();
    expect(sanitizeRedirect('javascript:alert(1)')).toBeNull();
  });

  it('拒绝反斜杠等会被规范化为站外的形态（CWE-601 回归）', () => {
    // 反斜杠绕过 startsWith('/')：/\\evil.example 会被浏览器规范化为 //evil.example
    expect(sanitizeRedirect('/\\evil.example.com')).toBeNull();
    expect(sanitizeRedirect('\\evil.example.com')).toBeNull();
    expect(sanitizeRedirect('/\\/evil.example.com')).toBeNull();
    expect(sanitizeRedirect('\\\\evil.example.com')).toBeNull();
    // 控制字符 / NUL 同样会被规范化
    expect(sanitizeRedirect('/\u0000evil.example.com')).toBeNull();
    expect(sanitizeRedirect('/\u0001evil.example.com')).toBeNull();
    expect(sanitizeRedirect('/\u001fevil.example.com')).toBeNull();
    expect(sanitizeRedirect('/\u007fevil.example.com')).toBeNull();
  });

  it('回跳目标是登录页本身时视为无效（避免登录后循环）', () => {
    expect(sanitizeRedirect('/login')).toBeNull();
    expect(sanitizeRedirect('/login?redirect=%2Fme')).toBeNull();
  });
});
