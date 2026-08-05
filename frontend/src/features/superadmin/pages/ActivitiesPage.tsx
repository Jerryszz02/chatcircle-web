import { useCallback, useEffect, useMemo, useState } from 'react';
import { collectionsForRole } from '../../../shared/api/collections';
import { normalizeApiError } from '../../../shared/api/http';
import type {
  ActivityRecord,
  ActivityStatus,
  OrganizationRecord,
} from '../../../shared/api/types';
import { Button, Card, Loading, Modal } from '../../../shared/ui';
import { SuperLayout } from '../SuperLayout';
import { useSuperToast } from '../hooks';
import { unpublishActivity } from '../api';
import { buildActivityFilter, canUnpublish } from '../lib/approvals';
import { formatDateTime } from '../lib/format';
import { ACTIVITY_STATUS_LABELS } from '../lib/labels';

type ActivityWithOrg = ActivityRecord & {
  expand?: { organization_id?: OrganizationRecord };
};

const PER_PAGE = 20;
const STATUS_OPTIONS = Object.entries(ACTIVITY_STATUS_LABELS) as [ActivityStatus, string][];

/**
 * 全平台活动监管（/super/activities）。
 * 按机构/状态筛选（FR-DASH-004 同口径）；下架仅对已发布活动可执行，
 * 下架后公开入口不可访问、历史保留（PRD §4.3），写审计。
 */
export function SuperActivitiesPage() {
  const { toast } = useSuperToast();
  const cc = useMemo(() => collectionsForRole('super'), []);

  const [orgs, setOrgs] = useState<OrganizationRecord[]>([]);
  const [orgFilter, setOrgFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<ActivityStatus | ''>('');

  const [items, setItems] = useState<ActivityWithOrg[] | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [takingDown, setTakingDown] = useState<ActivityWithOrg | null>(null);
  const [saving, setSaving] = useState(false);

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

  const load = useCallback(
    async (targetPage: number, orgId: string, status: ActivityStatus | '') => {
      const res = await cc.activities.getList<ActivityWithOrg>(targetPage, PER_PAGE, {
        filter: buildActivityFilter(orgId, status),
        sort: '-created',
        expand: 'organization_id',
      });
      setItems(res.items);
      setPage(res.page);
      setTotalPages(Math.max(1, res.totalPages));
    },
    [cc],
  );

  const runQuery = useCallback(
    (targetPage: number, orgId: string, status: ActivityStatus | '') => {
      void load(targetPage, orgId, status).catch((err) =>
        toast(normalizeApiError(err).message, 'error'),
      );
    },
    [load, toast],
  );

  useEffect(() => {
    runQuery(1, '', '');
    // 仅首屏加载；之后由「查询」按钮触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onTakeDown = async () => {
    if (!takingDown) return;
    setSaving(true);
    try {
      await unpublishActivity(takingDown.id);
      toast(`已下架「${takingDown.title}」`, 'success');
      setTakingDown(null);
      runQuery(page, orgFilter, statusFilter);
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SuperLayout title="全平台活动监管">
      <Card title="活动列表">
        <div className="sa-filter-bar">
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-act-org-filter">
              机构
            </label>
            <select
              id="sa-act-org-filter"
              className="sa-select"
              value={orgFilter}
              onChange={(e) => setOrgFilter(e.target.value)}
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
            <label className="cc-label" htmlFor="sa-act-status-filter">
              状态
            </label>
            <select
              id="sa-act-status-filter"
              className="sa-select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as ActivityStatus | '')}
            >
              <option value="">全部状态</option>
              {STATUS_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={() => runQuery(1, orgFilter, statusFilter)}>查询</Button>
        </div>

        {items === null ? (
          <Loading />
        ) : items.length === 0 ? (
          <p className="sa-muted">暂无符合条件的活动。</p>
        ) : (
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>活动</th>
                  <th>机构</th>
                  <th>状态</th>
                  <th>活动时间</th>
                  <th>名额（总/倾诉/聆听）</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((act) => (
                  <tr key={act.id}>
                    <td className="sa-cell-wrap">
                      <div>{act.title}</div>
                      <div className="sa-muted">{act.activity_code}</div>
                    </td>
                    <td className="sa-cell-wrap">
                      {act.expand?.organization_id?.name ?? act.organization_id}
                    </td>
                    <td>
                      <span
                        className={`sa-badge ${
                          act.status === 'published'
                            ? 'sa-badge-success'
                            : act.status === 'pending_review'
                              ? 'sa-badge-warn'
                              : act.status === 'taken_down' || act.status === 'rejected'
                                ? 'sa-badge-danger'
                                : ''
                        }`}
                      >
                        {ACTIVITY_STATUS_LABELS[act.status]}
                      </span>
                    </td>
                    <td>
                      {formatDateTime(act.start_time)}
                      <br />
                      {formatDateTime(act.end_time)}
                    </td>
                    <td>
                      {act.capacity_total} / {act.capacity_speaker} / {act.capacity_listener}
                    </td>
                    <td>
                      {canUnpublish(act) ? (
                        <Button variant="danger" onClick={() => setTakingDown(act)}>
                          下架
                        </Button>
                      ) : (
                        <span className="sa-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="sa-pagination">
          <Button variant="secondary" disabled={page <= 1} onClick={() => runQuery(page - 1, orgFilter, statusFilter)}>
            上一页
          </Button>
          <span>
            第 {page} / {totalPages} 页
          </span>
          <Button
            variant="secondary"
            disabled={page >= totalPages}
            onClick={() => runQuery(page + 1, orgFilter, statusFilter)}
          >
            下一页
          </Button>
        </div>
      </Card>

      {/* 下架确认 */}
      <Modal
        open={takingDown !== null}
        title="下架活动"
        onClose={() => setTakingDown(null)}
        footer={
          <>
            <Button variant="danger" loading={saving} onClick={() => void onTakeDown()}>
              确认下架
            </Button>
            <Button variant="secondary" onClick={() => setTakingDown(null)}>
              取消
            </Button>
          </>
        }
      >
        <p>
          确认下架「{takingDown?.title}」？下架后公开详情入口立即不可访问；
          活动与关联历史数据保留，可审计追溯（PRD §4.3）。
        </p>
      </Modal>
    </SuperLayout>
  );
}
