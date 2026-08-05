import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ActivityRecord, ActivityRole } from '../../../shared/api/types';
import { normalizeApiError } from '../../../shared/api/http';
import { listMetricDefinitions, MetricRenderer, type MetricData } from '../../../shared/metrics';
import type { MetricKey } from '../../../shared/metrics';
import { Button, Loading } from '../../../shared/ui';
import { AdminLayout } from '../components/AdminLayout';
import { StatusTag } from '../components/StatusTag';
import { adminCollections, fetchMetric, normalizeMetricValue, type MetricFilters } from '../lib/api';
import { ACTIVITY_ROLE_LABELS, ACTIVITY_STATUS_LABELS } from '../lib/labels';
import { formatDateTime } from '../lib/format';

/**
 * 本机构看板（/admin/dashboard，FR-DASH-001~005、AC-14/15）。
 *
 * 页面 = 筛选条 + 指标注册表渲染结果（不写死单指标卡片，technical-design §5.6）；
 * 数据来自 GET /api/cc/metrics/:metric_key，机构范围由服务端按身份注入；
 * 去重指标口径说明由注册表 note 自动展示（「去重参与账号数，多账号不合并」，PRD §7.1）。
 * 活动明细下钻用 activities 集合 API（本机构），行内可跳转活动管理页。
 */
export function AdminDashboardPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [activityStatus, setActivityStatus] = useState('');
  const [activityRole, setActivityRole] = useState<'' | ActivityRole>('');

  const [dataMap, setDataMap] = useState<Partial<Record<MetricKey, MetricData>>>({});
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState('');
  const [activities, setActivities] = useState<ActivityRecord[] | null>(null);
  const [activitiesError, setActivitiesError] = useState('');

  const load = useCallback(async () => {
    const filters: MetricFilters = {
      from: from || undefined,
      to: to || undefined,
      activity_status: activityStatus || undefined,
      activity_role: activityRole || undefined,
    };
    setMetricsLoading(true);
    setMetricsError('');
    setActivitiesError('');
    // 指标聚合（服务端按身份注入机构范围）
    const results = await Promise.allSettled(
      listMetricDefinitions().map(async (def) => {
        const raw = await fetchMetric(def.metricKey, filters);
        return [def.metricKey, normalizeMetricValue(def.metricKey, raw)] as const;
      }),
    );
    const next: Partial<Record<MetricKey, MetricData>> = {};
    let failed = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        next[result.value[0]] = result.value[1];
      } else {
        failed += 1;
      }
    }
    setDataMap(next);
    if (failed > 0) {
      const first = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      setMetricsError(`部分指标加载失败（${failed} 项）：${normalizeApiError(first?.reason).message}`);
    }
    setMetricsLoading(false);

    // 活动明细下钻（口径：已发布/已关闭/已归档计入活动场次，FR-DASH-002 与导出一致）
    try {
      const conditions: string[] = [
        activityStatus
          ? `status = "${activityStatus}"`
          : 'status = "published" || status = "closed" || status = "archived"',
      ];
      if (from) conditions.push(`start_time >= "${from} 00:00:00"`);
      if (to) conditions.push(`start_time <= "${to} 23:59:59"`);
      const list = await adminCollections().activities.getFullList({
        filter: conditions.map((c) => `(${c})`).join(' && '),
        sort: '-start_time',
      });
      setActivities(list);
    } catch (err) {
      setActivitiesError(normalizeApiError(err).message);
      setActivities([]);
    }
  }, [from, to, activityStatus, activityRole]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AdminLayout title="本机构看板">
      <div className="admin-toolbar" role="search" aria-label="看板筛选">
        <div className="cc-field">
          <label className="cc-label" htmlFor="dash-from">
            开始日期
          </label>
          <input
            id="dash-from"
            className="cc-input"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="cc-field">
          <label className="cc-label" htmlFor="dash-to">
            结束日期
          </label>
          <input
            id="dash-to"
            className="cc-input"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="cc-field">
          <label className="cc-label" htmlFor="dash-status">
            活动状态
          </label>
          <select
            id="dash-status"
            className="admin-select"
            value={activityStatus}
            onChange={(e) => setActivityStatus(e.target.value)}
          >
            <option value="">全部状态</option>
            {Object.entries(ACTIVITY_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="cc-field">
          <label className="cc-label" htmlFor="dash-role">
            活动角色
          </label>
          <select
            id="dash-role"
            className="admin-select"
            value={activityRole}
            onChange={(e) => setActivityRole(e.target.value as '' | ActivityRole)}
          >
            <option value="">全部角色</option>
            {(Object.keys(ACTIVITY_ROLE_LABELS) as ActivityRole[]).map((role) => (
              <option key={role} value={role}>
                {ACTIVITY_ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </div>
        <Button variant="secondary" onClick={() => void load()}>
          刷新
        </Button>
      </div>

      {metricsError ? (
        <p className="cc-error" role="alert">
          {metricsError}
        </p>
      ) : null}
      <div className="admin-metric-grid">
        {listMetricDefinitions().map((def) => (
          <MetricRenderer
            key={def.metricKey}
            definition={def}
            data={dataMap[def.metricKey]}
            loading={metricsLoading}
          />
        ))}
      </div>

      <section className="admin-section" aria-label="活动明细">
        <h2>活动明细（下钻）</h2>
        <p className="admin-muted">
          口径与活动场次指标一致（已发布/已关闭/已归档；草稿、待审核、已驳回不计，PRD §7.1）。
        </p>
        {activitiesError ? (
          <p className="cc-error" role="alert">
            {activitiesError}
          </p>
        ) : null}
        {activities === null && !activitiesError ? <Loading label="明细加载中…" /> : null}
        {activities !== null && activities.length === 0 && !activitiesError ? (
          <p className="admin-empty">筛选范围内暂无活动。</p>
        ) : null}
        {activities && activities.length > 0 ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>标题</th>
                  <th>代码</th>
                  <th>状态</th>
                  <th>开始时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {activities.map((a) => (
                  <tr key={a.id}>
                    <td>{a.title}</td>
                    <td>
                      <code>{a.activity_code}</code>
                    </td>
                    <td>
                      <StatusTag label={ACTIVITY_STATUS_LABELS[a.status]} tone="info" />
                    </td>
                    <td>{formatDateTime(a.start_time)}</td>
                    <td>
                      <Link to={`/admin/activities/${a.id}`}>
                        <Button variant="secondary">管理</Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </AdminLayout>
  );
}
