import { describe, expect, it } from 'vitest';
import { normalizeMetricValue } from './api';

/**
 * 看板指标响应规范化单测（technical-design §5.6：GET /api/cc/metrics/:metric_key）。
 * 后端响应形态落地前按防御式兼容：value/count/ratio 字段或裸数字；
 * 完成率（ratio 口径）按百分比展示（PRD §7.1）。
 */
describe('normalizeMetricValue', () => {
  it('数值字段优先取 value，其次 count/ratio', () => {
    expect(normalizeMetricValue('approvals', { value: 12 })).toEqual({ value: 12 });
    expect(normalizeMetricValue('approvals', { count: 7 })).toEqual({ value: 7 });
    expect(normalizeMetricValue('service_visits', { value: 3, count: 9 })).toEqual({ value: 3 });
  });

  it('裸数字响应直接使用', () => {
    expect(normalizeMetricValue('activity_sessions', 5)).toEqual({ value: 5 });
  });

  it('完成率按百分比展示：0-1 小数与百分数两种输入', () => {
    expect(normalizeMetricValue('survey_completion_rate', { value: 0.5 })).toEqual({ value: '50%' });
    expect(normalizeMetricValue('survey_completion_rate', { ratio: 0.756 })).toEqual({
      value: '75.6%',
    });
    expect(normalizeMetricValue('survey_completion_rate', { value: 62 })).toEqual({ value: '62%' });
  });

  it('缺失/非法数据回退占位符，不抛错', () => {
    expect(normalizeMetricValue('approvals', undefined)).toEqual({ value: '—' });
    expect(normalizeMetricValue('approvals', null)).toEqual({ value: '—' });
    expect(normalizeMetricValue('approvals', {})).toEqual({ value: '—' });
    expect(normalizeMetricValue('approvals', { value: Number.NaN })).toEqual({ value: '—' });
  });
});
