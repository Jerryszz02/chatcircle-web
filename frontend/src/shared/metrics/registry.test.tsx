import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  METRIC_DEFINITIONS,
  MetricRenderer,
  getMetricDefinition,
  listMetricDefinitions,
  type MetricKey,
} from './index';

/** V1 初始 8 项指标（technical-design §5.6）。 */
const INITIAL_KEYS: MetricKey[] = [
  'activity_sessions',
  'applications',
  'approvals',
  'rejections',
  'service_visits',
  'unique_participants',
  'survey_submissions',
  'survey_completion_rate',
];

describe('看板指标注册表（technical-design §5.6）', () => {
  it('V1 初始 8 项指标全部注册且无重复', () => {
    const keys = METRIC_DEFINITIONS.map((d) => d.metricKey);
    expect(keys).toHaveLength(INITIAL_KEYS.length);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of INITIAL_KEYS) {
      expect(keys).toContain(key);
    }
  });

  it('每条配置具备 PRD §7.2 要求的完整维度', () => {
    for (const def of METRIC_DEFINITIONS) {
      expect(def.title).toBeTruthy();
      expect(def.dataSource).toBeTruthy();
      expect(['count', 'countDistinct', 'ratio']).toContain(def.aggregation);
      expect(['card', 'trend', 'role_split', 'table']).toContain(def.displayType);
      expect(def.description).toBeTruthy();
      expect(Array.isArray(def.filters)).toBe(true);
    }
  });

  it('getMetricDefinition 命中与未命中行为正确', () => {
    expect(getMetricDefinition('approvals')?.metricKey).toBe('approvals');
    expect(listMetricDefinitions()).toBe(METRIC_DEFINITIONS);
    // @ts-expect-error 未注册的 key 在类型上不可写，运行时返回 undefined
    expect(getMetricDefinition('not_a_metric')).toBeUndefined();
  });

  it('去重指标必须注明「去重参与账号数」与多账号不合并口径（AC-15）', () => {
    const def = getMetricDefinition('unique_participants');
    expect(def?.aggregation).toBe('countDistinct');
    expect(def?.note).toContain('去重参与账号数');
    expect(def?.note).toContain('不合并');
  });

  it('MetricRenderer 按 displayType 渲染：指标卡展示数值与口径提示', () => {
    const def = getMetricDefinition('unique_participants');
    render(<MetricRenderer definition={def!} data={{ value: 42, unit: '人' }} />);
    expect(screen.getByText('去重参与人数')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText(/去重参与账号数/)).toBeInTheDocument();
  });

  it('loading 与无数据均有可读占位，不渲染空白卡', () => {
    const def = getMetricDefinition('service_visits');
    const { rerender } = render(<MetricRenderer definition={def!} loading />);
    expect(screen.getByText('加载中…')).toBeInTheDocument();

    rerender(<MetricRenderer definition={def!} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
