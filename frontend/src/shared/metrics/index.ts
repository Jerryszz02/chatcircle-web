/** 看板指标注册表统一出口（technical-design §5.6）。 */
export { METRIC_DEFINITIONS, getMetricDefinition, listMetricDefinitions } from './registry';
export type {
  MetricAggregation,
  MetricDefinition,
  MetricDisplayType,
  MetricFilter,
  MetricKey,
} from './registry';
export {
  MetricCard,
  MetricRenderer,
  MetricRoleSplit,
  MetricTable,
  MetricTrend,
} from './MetricRenderer';
export type {
  MetricCardData,
  MetricData,
  MetricRendererProps,
  MetricRoleSplitData,
  MetricTableData,
  MetricTrendData,
} from './MetricRenderer';
