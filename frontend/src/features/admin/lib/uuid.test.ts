import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from './uuid';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUUID', () => {
  it('生成合法的 UUID v4 字符串', () => {
    expect(randomUUID()).toMatch(UUID_V4_RE);
  });

  it('crypto.randomUUID 不存在时（非安全上下文）降级生成合法 UUID', () => {
    const original = crypto.randomUUID;
    // 模拟 http:// 局域网访问等非安全上下文：randomUUID 未定义
    vi.stubGlobal('crypto', {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });
    try {
      const id = randomUUID();
      expect(id).toMatch(UUID_V4_RE);
    } finally {
      vi.unstubAllGlobals();
      void original;
    }
  });

  it('多次生成不重复', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => randomUUID()));
    expect(ids.size).toBe(1000);
  });
});
