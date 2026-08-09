import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localDayToPbUtcRange, parsePbDate, toPbDateTimeUtc } from './datetime';

describe('parsePbDate', () => {
  it('解析 PB 空格形态与 ISO 形态（均为 UTC）', () => {
    expect(parsePbDate('2026-08-05 02:31:55.947Z')?.toISOString()).toBe('2026-08-05T02:31:55.947Z');
    expect(parsePbDate('2026-08-05T02:31:55.947Z')?.toISOString()).toBe('2026-08-05T02:31:55.947Z');
  });

  it('空值/非法值返回 null', () => {
    expect(parsePbDate('')).toBeNull();
    expect(parsePbDate(undefined)).toBeNull();
    expect(parsePbDate('not-a-date')).toBeNull();
  });
});

describe('localDayToPbUtcRange（本地自然日 → UTC 边界）', () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    // 固定东八区验证边界换算（Node 运行时修改 TZ 对后续 Date 构造生效）
    process.env.TZ = 'Asia/Shanghai';
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('UTC+8：本地 2026-08-07 → [2026-08-06 16:00Z, 2026-08-07 16:00Z)', () => {
    expect(localDayToPbUtcRange('2026-08-07')).toEqual({
      gte: '2026-08-06 16:00:00.000Z',
      lt: '2026-08-07 16:00:00.000Z',
    });
  });

  it('UTC+8：月初跨界（本地 2026-08-01 → 上一个月末 UTC 起点）', () => {
    expect(localDayToPbUtcRange('2026-08-01')).toEqual({
      gte: '2026-07-31 16:00:00.000Z',
      lt: '2026-08-01 16:00:00.000Z',
    });
  });

  it('空值/形态非法/不存在的日期返回 null', () => {
    expect(localDayToPbUtcRange('')).toBeNull();
    expect(localDayToPbUtcRange('2026/08/07')).toBeNull();
    expect(localDayToPbUtcRange('2026-13-01')).toBeNull();
    expect(localDayToPbUtcRange('2026-02-31')).toBeNull();
  });
});

describe('toPbDateTimeUtc', () => {
  it('输出 PocketBase 日期格式（空格分隔 + Z）', () => {
    expect(toPbDateTimeUtc(new Date('2026-08-06T16:00:00.000Z'))).toBe('2026-08-06 16:00:00.000Z');
  });
});
