import { describe, expect, it } from 'vitest';
import {
  normalizeUsername,
  USERNAME_PATTERN,
  validatePassword,
  validateUsername,
} from './username';

/**
 * 用户名规则单测（FR-AUTH-005、AC-06；test-plan §2「用户名校验函数」）。
 * 与服务端 participant_accounts.username pattern（迁移 1785888180）保持一致。
 */
describe('用户名规则（FR-AUTH-005）', () => {
  it('归一化：去首尾空白并转小写（大小写不敏感唯一）', () => {
    expect(normalizeUsername('  AbC_09 ')).toBe('abc_09');
    expect(normalizeUsername('USER')).toBe('user');
  });

  it('合法用户名通过校验', () => {
    expect(validateUsername('user_01')).toBeNull();
    expect(validateUsername('AbCd_123')).toBeNull(); // 大写归一化后合法
    expect(validateUsername('abcd')).toBeNull(); // 下限 4 位
    expect(validateUsername('a'.repeat(20))).toBeNull(); // 上限 20 位
  });

  it('非法用户名被拒绝并给出可读文案', () => {
    expect(validateUsername('')).toBe('请输入用户名');
    expect(validateUsername('   ')).toBe('请输入用户名');
    expect(validateUsername('abc')).toContain('4–20 位');
    expect(validateUsername('a'.repeat(21))).toContain('4–20 位');
    expect(validateUsername('中文用户')).toContain('字母、数字、下划线');
    expect(validateUsername('user-name')).toContain('字母、数字、下划线');
    expect(validateUsername('user name')).toContain('字母、数字、下划线');
    expect(validateUsername('user@x')).toContain('字母、数字、下划线');
  });

  it('归一化后的合法用户名必命中服务端 pattern（^[a-z0-9_]{4,20}$）', () => {
    for (const raw of ['user_01', 'AbCd_123', 'abcd', 'a'.repeat(20)]) {
      expect(USERNAME_PATTERN.test(normalizeUsername(raw))).toBe(true);
    }
    for (const raw of ['abc', 'a'.repeat(21), 'user-name', '中文用户']) {
      expect(USERNAME_PATTERN.test(normalizeUsername(raw))).toBe(false);
    }
  });

  it('密码体验层校验（最小长度，服务端为准）', () => {
    expect(validatePassword('')).toBe('请输入密码');
    expect(validatePassword('1234567')).toContain('至少 8 位');
    expect(validatePassword('12345678')).toBeNull();
  });
});
