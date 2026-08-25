import { useCallback, useEffect, useMemo, useState } from 'react';
import { collectionsForRole } from '../../../shared/api/collections';
import { normalizeApiError } from '../../../shared/api/http';
import type { ActivityStatus, OrganizationRecord } from '../../../shared/api/types';
import { localDayToPbUtcRange } from '../../../shared/lib/datetime';
import { MetricRenderer, type MetricData } from '../../../shared/metrics/MetricRenderer';
import {
  listMetricDefinitions,
  type MetricKey,
} from '../../../shared/metrics/registry';
import { Button, Card, Loading } from '../../../shared/ui';
import { SuperLayout } from '../SuperLayout';
import { useSuperToast } from '../hooks';
import { fetchMetric, type MetricFilters } from '../api';
import { BackupAlarmBanner } from '../components/BackupAlarmBanner';
import { useBackupStatus } from '../hooks';
import { ACTIVITY_ROLE_LABELS, ACTIVITY_STATUS_LABELS } from '../lib/labels';

// 看板口径只统计 已发布/已关闭/已归档（metrics.pb.js activity_sessions 白名单，
// technical-design §5.6）；草稿/待平台审核/已驳回恒为 0，不提供筛选项
const STATUS_OPTIONS = (Object.entries(ACTIVITY_STATUS_LABELS) as [ActivityStatus, string][]).filter(
  ([value]) => !['draft', 'pending_review', 'rejected'].includes(value),
);

/**
 * 全局看板（/super/dashboard，FR-DASH-001~005、technical-design §5.6）。
 * - 页面 = 顶部筛选条 + 指标配置数组渲染（MetricRenderer），无写死的单指标卡；
 * - 筛选：日期区间 / 机构 / 活动状态 / 活动内角色，统一作用于全部卡片；
 * - 去重指标口径说明随注册表 note 展示（同一自然人多账号不合并，PRD §7.1）；
 * - 备份失败告警位（technical-design §5.8：/super/system 及全局看板）。
 */
export function SuperDashboardPage() {
  const { toast } = useSuperToast();
  const cc = useMemo(() => collectionsForRole('super'), []);
  const backup = useBackupStatus();

  const [orgs, setOrgs] = useState<OrganizationRecord[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [orgId, setOrgId] = useState('');
  const [activityStatus, setActivityStatus] = useState<ActivityStatus | ''>('');
  const [activityRole, setActivityRole] = useState('');

  const [dataMap, setDataMap] = useState<Partial<Record<MetricKey, MetricData>>>({});
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void cc.organizations
      .getFullList({ sort: 'created' })
      .then((list) => {
        if (!cancelled) setOrgs(list);
      })
      .catch((err) => {
        if (!cancelled) toast(normalizeApiError(err).message, 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [cc, toast]);

  const definitions = useMemo(() => listMetricDefinitions(), []);

  const query = useCallback(async () => {
    setLoading(true);
    // 本地日期 → 该自然日对应的 UTC 边界（PB 按 UTC 存储比较，直接发本地日期会偏移一个时区）；
    // 与机构端看板共用同一时区口径（datetime 形式，左闭右开）
    const fromRange = from ? localDayToPbUtcRange(from) : null;
    const toRange = to ? localDayToPbUtcRange(to) : null;
    const filters: MetricFilters = {
      from: fromRange?.gte,
      to: toRange?.lt,
      organization_id: orgId || undefined,
      activity_status: activityStatus || undefined,
      activity_role: activityRole || undefined,
    };
    // 单指标失败不拖垮整页：失败的卡片保持空值展示
    const results = await Promise.all(
      definitions.map(async (def) => {
        try {
          const data = await fetchMetric(def.metricKey, filters);
          return [def.metricKey, data] as const;
        } catch {
          return [def.metricKey, undefined] as const;
        }
      }),
    );
    const next: Partial<Record<MetricKey, MetricData>> = {};
    let failed = 0;
    for (const [key, data] of results) {
      if (data === undefined) failed += 1;
      else next[key] = data;
    }
    setDataMap(next);
    setLoaded(true);
    setLoading(false);
    if (failed > 0) {
      toast(`${failed} 项指标加载失败，请稍后重试`, 'error');
    }
  }, [definitions, from, to, orgId, activityStatus, activityRole, toast]);

  useEffect(() => {
    void query();
    // 仅首屏自动查询；筛选变更后由「查询」按钮触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SuperLayout title="全局看板">
      {backup.status ? <BackupAlarmBanner status={backup.status} /> : null}

      <Card title="筛选">
        <div className="sa-filter-bar">
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-dash-from">
              开始日期
            </label>
            <input
              id="sa-dash-from"
              className="cc-input"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-dash-to">
              结束日期
            </label>
            <input
              id="sa-dash-to"
              className="cc-input"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-dash-org">
              机构
            </label>
            <select
              id="sa-dash-org"
              className="sa-select"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
            >
              <option value="">全部机构</option>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </div>
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-dash-status">
              活动状态
            </label>
            <select
              id="sa-dash-status"
              className="sa-select"
              value={activityStatus}
              onChange={(e) => setActivityStatus(e.target.value as ActivityStatus | '')}
            >
              <option value="">全部状态</option>
              {STATUS_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-dash-role">
              参与角色
            </label>
            <select
              id="sa-dash-role"
              className="sa-select"
              value={activityRole}
              onChange={(e) => setActivityRole(e.target.value)}
            >
              <option value="">全部角色</option>
              <option value="speaker">{ACTIVITY_ROLE_LABELS.speaker}</option>
              <option value="listener">{ACTIVITY_ROLE_LABELS.listener}</option>
            </select>
          </div>
          <Button loading={loading} onClick={() => void query()}>
            查询
          </Button>
        </div>
        <p className="sa-muted">
          筛选统一作用于全部指标卡（FR-DASH-004）；看板口径与导出口径一致（FR-DASH-002）。
          去重指标按「去重参与账号数」统计，同一自然人多账号不合并（PRD §7.1）。
        </p>
      </Card>

      {!loaded && loading ? (
        <Loading />
      ) : (
        <div className="sa-metrics-grid">
          {definitions.map((def) => (
            <MetricRenderer
              key={def.metricKey}
              definition={def}
              data={dataMap[def.metricKey]}
              loading={loading}
            />
          ))}
        </div>
      )}
    </SuperLayout>
  );
}
