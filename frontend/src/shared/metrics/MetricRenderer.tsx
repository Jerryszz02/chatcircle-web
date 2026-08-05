import type { ReactNode } from 'react';
import type { MetricDefinition, MetricDisplayType } from './registry';

/**
 * 看板通用渲染组件（technical-design §5.6）。
 *
 * 数据来自约定聚合端点 GET /api/cc/metrics/:metric_key（后端落地前以下为展示占位形态），
 * 页面按「指标配置数组 + 各自数据」渲染，不针对单个指标写 JSX：
 *
 *   {listMetricDefinitions().map((def) => (
 *     <MetricRenderer key={def.metricKey} definition={def} data={dataMap[def.metricKey]} loading={loading} />
 *   ))}
 */

/** 指标卡数据（displayType=card）。 */
export interface MetricCardData {
  value: number | string;
  /** 可选单位/副文案，如「场」「人次」。 */
  unit?: string;
}

/** 趋势数据（displayType=trend）。 */
export interface MetricTrendData {
  points: { label: string; value: number }[];
}

/** 角色拆分数据（displayType=role_split）。 */
export interface MetricRoleSplitData {
  speaker?: number;
  listener?: number;
  total?: number;
}

/** 明细表数据（displayType=table）。 */
export interface MetricTableData {
  columns: string[];
  rows: (string | number)[][];
}

/** 各展示形态的数据联合。 */
export type MetricData = MetricCardData | MetricTrendData | MetricRoleSplitData | MetricTableData;

export interface MetricRendererProps {
  definition: MetricDefinition;
  /** 聚合端点返回数据；undefined 表示尚未加载。 */
  data?: MetricData;
  loading?: boolean;
}

function Frame({ definition, children }: { definition: MetricDefinition; children: ReactNode }) {
  return (
    <section className="cc-metric" aria-label={definition.title}>
      <h3 className="cc-metric-title">{definition.title}</h3>
      {children}
      {definition.note ? <p className="cc-metric-note">{definition.note}</p> : null}
    </section>
  );
}

export function MetricCard({ value, unit }: { value?: number | string; unit?: string }) {
  return (
    <p className="cc-metric-value">
      {value ?? '—'}
      {unit ? <span className="cc-metric-unit">{unit}</span> : null}
    </p>
  );
}

/** 趋势图占位：V1 纯 CSS 实现，后续可替换为图表库而不改页面结构。 */
export function MetricTrend({ points }: { points?: MetricTrendData['points'] }) {
  if (!points || points.length === 0) {
    return <p className="cc-metric-empty">暂无数据</p>;
  }
  return (
    <ul className="cc-metric-trend">
      {points.map((p) => (
        <li key={p.label}>
          <span>{p.label}</span>
          <span>{p.value}</span>
        </li>
      ))}
    </ul>
  );
}

export function MetricRoleSplit({ speaker, listener, total }: Partial<MetricRoleSplitData>) {
  return (
    <dl className="cc-metric-split">
      <div>
        <dt>倾诉者</dt>
        <dd>{speaker ?? '—'}</dd>
      </div>
      <div>
        <dt>聆听者</dt>
        <dd>{listener ?? '—'}</dd>
      </div>
      {total !== undefined ? (
        <div>
          <dt>合计</dt>
          <dd>{total}</dd>
        </div>
      ) : null}
    </dl>
  );
}

export function MetricTable({
  columns,
  rows,
}: {
  columns?: string[];
  rows?: (string | number)[][];
}) {
  if (!columns || !rows || rows.length === 0) {
    return <p className="cc-metric-empty">暂无数据</p>;
  }
  return (
    <table className="cc-metric-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderBody(displayType: MetricDisplayType, data: MetricData | undefined): ReactNode {
  switch (displayType) {
    case 'card': {
      const d = data as MetricCardData | undefined;
      return <MetricCard value={d?.value} unit={d?.unit} />;
    }
    case 'trend':
      return <MetricTrend points={(data as MetricTrendData | undefined)?.points} />;
    case 'role_split': {
      const d = data as MetricRoleSplitData | undefined;
      return <MetricRoleSplit speaker={d?.speaker} listener={d?.listener} total={d?.total} />;
    }
    case 'table': {
      const d = data as MetricTableData | undefined;
      return <MetricTable columns={d?.columns} rows={d?.rows} />;
    }
  }
}

/** 按指标配置选择渲染组件；loading 时展示加载态，未注册指标由调用方按 getMetricDefinition 判空。 */
export function MetricRenderer({ definition, data, loading }: MetricRendererProps) {
  return (
    <Frame definition={definition}>
      {loading ? (
        <p className="cc-metric-empty">加载中…</p>
      ) : (
        renderBody(definition.displayType, data)
      )}
    </Frame>
  );
}
