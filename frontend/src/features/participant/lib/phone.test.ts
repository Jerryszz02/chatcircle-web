import { describe, expect, it } from 'vitest';
import { normalizeMainlandPhone, validateMainlandPhone, validatePhoneCode } from './phone';

describe('participant phone helpers', () => {
  it.each([
    ['13812345678', '+8613812345678'],
    ['+86 138-1234-5678', '+8613812345678'],
    ['008613812345678', '+8613812345678'],
  ])('normalizes %s to E.164', (input, expected) => {
    expect(normalizeMainlandPhone(input)).toBe(expected);
  });

  it('rejects unsupported or malformed phones', () => {
    expect(validateMainlandPhone('')).toBe('请输入手机号');
    expect(validateMainlandPhone('+1 2025550123')).toBe('请输入有效的中国大陆手机号');
  });

  it('accepts only 4-8 digit verification codes', () => {
    expect(validatePhoneCode('246810')).toBeNull();
    expect(validatePhoneCode('12a4')).toBe('验证码应为 4–8 位数字');
  });
});
