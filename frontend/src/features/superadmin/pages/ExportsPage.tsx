import { useCallback, useEffect, useMemo, useState } from 'react';
import { collectionsForRole } from '../../../shared/api/collections';
import { normalizeApiError } from '../../../shared/api/http';
import type {
  ActivityRecord,
  ExportJobRecord,
  ExportScope,
  OrganizationRecord,
} from '../../../shared/api/types';
import { Button, Card, Loading, Modal } from '../../../shared/ui';
import { SuperLayout } from '../SuperLayout';
import { useSuperToast } from '../hooks';
import { createExportJob, downloadExportFile } from '../api';
import { buildExportScope } from '../lib/exportScope';
import { formatDateTime } from '../lib/format';
import { EXPORT_SCOPE_TYPE_LABELS, EXPORT_STATUS_LABELS } from '../lib/labels';

type ActivityWithOrg = ActivityRecord & {
  expand?: { organization_id?: OrganizationRecord };
};
type ExportJobWithOrg = ExportJobRecord & {
  expand?: { organization_id?: OrganizationRecord };
};

const PER_PAGE = 20;
/** 活动下拉选项上限：全平台活动可能很多，只取最近创建的若干条（超出时给提示）。 */
const ACTIVITY_OPTION_LIMIT = 200;

/** 导出范围的可读摘要（确认框与记录列表共用）。 */
function scopeSummary(
  scope: ExportScope,
  orgName?: string,
  activityTitle?: string,
): string {
  switch (scope.type) {
    case 'platform':
      return '全平台';
    case 'organization':
      return `机构：${orgName ?? '（未知机构）'}`;
    case 'activity':
      return `单活动：${activityTitle ?? scope.activity_id ?? '（未知活动）'}`;
  }
}

/**
 * 全局导出（/super/exports，FR-EXP-001~006）。
 * - 范围：全平台 / 机构 / 单活动（FR-EXP-004，服务端校验范围合法性）；
 * - 敏感导出：主动勾选 + 二次确认（本页确认弹窗）+ 审计（AC-17、FR-EXP-003）；
 * - 记录列表与鉴权下载（FR-EXP-005：受保护目录、不可猜 URL、不自动失效）。
 */
export function SuperExportsPage() {
  const { toast } = useSuperToast();
  const cc = useMemo(() => collectionsForRole('super'), []);

  // 表单
  const [scopeType, setScopeType] = useState<ExportScope['type']>('platform');
  const [scopeOrgId, setScopeOrgId] = useState('');
  const [scopeActivityId, setScopeActivityId] = useState('');
  const [includePii, setIncludePii] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  // 选项数据
  const [orgs, setOrgs] = useState<OrganizationRecord[]>([]);
  const [activities, setActivities] = useState<ActivityWithOrg[]>([]);
  const [activitiesTruncated, setActivitiesTruncated] = useState(false);

  // 记录列表
  const [jobs, setJobs] = useState<ExportJobWithOrg[] | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      cc.organizations.getFullList({ sort: 'created' }),
      // 下拉选项分页拉取（不用 getFullList 全量）：超出上限时提示仅展示最近活动
      cc.activities.getList<ActivityWithOrg>(1, ACTIVITY_OPTION_LIMIT, {
        sort: '-created',
        expand: 'organization_id',
      }),
    ])
      .then(([orgList, actRes]) => {
        if (!cancelled) {
          setOrgs(orgList);
          setActivities(actRes.items);
          setActivitiesTruncated(actRes.totalItems > actRes.items.length);
        }
      })
      .catch((err) => {
        if (!cancelled) toast(normalizeApiError(err).message, 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [cc, toast]);

  const loadJobs = useCallback(
    async (targetPage: number) => {
      const res = await cc.exportJobs.getList<ExportJobWithOrg>(targetPage, PER_PAGE, {
        sort: '-created',
        expand: 'organization_id',
      });
      setJobs(res.items);
      setPage(res.page);
      setTotalPages(Math.max(1, res.totalPages));
    },
    [cc],
  );

  useEffect(() => {
    let cancelled = false;
    void cc.exportJobs
      .getList<ExportJobWithOrg>(1, PER_PAGE, { sort: '-created', expand: 'organization_id' })
      .then((res) => {
        if (!cancelled) {
          setJobs(res.items);
          setPage(res.page);
          setTotalPages(Math.max(1, res.totalPages));
        }
      })
      .catch((err) => {
        if (!cancelled) toast(normalizeApiError(err).message, 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [cc, toast]);

  const orgNameOf = useCallback(
    (id?: string) => orgs.find((o) => o.id === id)?.name,
    [orgs],
  );
  const activityTitleOf = useCallback(
    (id?: string) => activities.find((a) => a.id === id)?.title,
    [activities],
  );

  const buildScope = (): ExportScope | null => buildExportScope(scopeType, scopeOrgId, scopeActivityId);

  const onSubmit = () => {
    const scope = buildScope();
    if (!scope) {
      toast(scopeType === 'organization' ? '请选择机构' : '请选择活动', 'error');
      return;
    }
    if (includePii) {
      // 敏感导出必须二次确认（AC-17）
      setConfirmOpen(true);
      return;
    }
    void doCreate(scope, false);
  };

  const doCreate = async (scope: ExportScope, pii: boolean) => {
    setCreating(true);
    try {
      await createExportJob({ scope, include_pii: pii });
      toast(pii ? '敏感导出任务已创建（已写审计）' : '导出任务已创建', 'success');
      setConfirmOpen(false);
      setIncludePii(false);
      await loadJobs(1);
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setCreating(false);
    }
  };

  const onDownload = async (job: ExportJobRecord) => {
    setDownloadingId(job.id);
    try {
      await downloadExportFile(job);
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setDownloadingId(null);
    }
  };

  const pendingScope = buildScope();

  return (
    <SuperLayout title="全局导出">
      <Card title="新建导出">
        <div className="cc-field">
          <span className="cc-label">导出范围（FR-EXP-004）</span>
          <div className="sa-actions" role="radiogroup" aria-label="导出范围">
            {(Object.keys(EXPORT_SCOPE_TYPE_LABELS) as ExportScope['type'][]).map((type) => (
              <label key={type} className="cc-label">
                <input
                  type="radio"
                  name="sa-export-scope"
                  checked={scopeType === type}
                  onChange={() => setScopeType(type)}
                />{' '}
                {EXPORT_SCOPE_TYPE_LABELS[type]}
              </label>
            ))}
          </div>
        </div>

        {scopeType === 'organization' ? (
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-export-org">
              机构
            </label>
            <select
              id="sa-export-org"
              className="sa-select"
              value={scopeOrgId}
              onChange={(e) => setScopeOrgId(e.target.value)}
            >
              <option value="">请选择机构</option>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {scopeType === 'activity' ? (
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-export-activity">
              活动
            </label>
            <select
              id="sa-export-activity"
              className="sa-select"
              value={scopeActivityId}
              onChange={(e) => setScopeActivityId(e.target.value)}
            >
              <option value="">请选择活动</option>
              {activities.map((act) => (
                <option key={act.id} value={act.id}>
                  {act.expand?.organization_id?.name ? `${act.expand.organization_id.name} / ` : ''}
                  {act.title}（{act.activity_code}）
                </option>
              ))}
            </select>
            {activitiesTruncated ? (
              <p className="cc-hint">
                仅显示最近创建的 {ACTIVITY_OPTION_LIMIT} 个活动；更早的活动请前往对应机构的管理端导出。
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="cc-field">
          <label className="cc-label">
            <input
              type="checkbox"
              checked={includePii}
              onChange={(e) => setIncludePii(e.target.checked)}
            />{' '}
            包含个人信息字段（敏感导出）
          </label>
          <p className="cc-hint">
            普通导出按 is_sensitive 标记排除姓名、手机号等直接身份信息，跨表以 participant_id 关联（FR-EXP-002）；
            敏感导出需二次确认并写入审计（FR-EXP-003）。
          </p>
        </div>

        <Button loading={creating} onClick={onSubmit}>
          创建导出
        </Button>
      </Card>

      <Card
        title="导出记录"
        actions={
          <Button
            variant="secondary"
            onClick={() =>
              void loadJobs(page).catch((err) => toast(normalizeApiError(err).message, 'error'))
            }
          >
            刷新
          </Button>
        }
      >
        {jobs === null ? (
          <Loading />
        ) : jobs.length === 0 ? (
          <p className="sa-muted">暂无导出记录。</p>
        ) : (
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>创建时间</th>
                  <th>范围</th>
                  <th>含个人信息</th>
                  <th>状态</th>
                  <th>文件校验</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{formatDateTime(job.created)}</td>
                    <td className="sa-cell-wrap">
                      {scopeSummary(
                        job.scope_json,
                        job.expand?.organization_id?.name ?? orgNameOf(job.organization_id),
                        activityTitleOf(job.scope_json.activity_id),
                      )}
                    </td>
                    <td>
                      {job.include_pii ? (
                        <span className="sa-badge sa-badge-danger">是（敏感导出）</span>
                      ) : (
                        '否'
                      )}
                    </td>
                    <td>
                      <span
                        className={`sa-badge ${
                          job.status === 'done'
                            ? 'sa-badge-success'
                            : job.status === 'failed'
                              ? 'sa-badge-danger'
                              : 'sa-badge-warn'
                        }`}
                      >
                        {EXPORT_STATUS_LABELS[job.status]}
                      </span>
                    </td>
                    <td className="sa-cell-wrap">
                      <span className="sa-muted">{job.file_checksum ?? '—'}</span>
                    </td>
                    <td>
                      {job.status === 'done' ? (
                        <Button
                          variant="secondary"
                          loading={downloadingId === job.id}
                          onClick={() => void onDownload(job)}
                        >
                          下载 ZIP
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
          <Button
            variant="secondary"
            disabled={page <= 1}
            onClick={() =>
              void loadJobs(page - 1).catch((err) => toast(normalizeApiError(err).message, 'error'))
            }
          >
            上一页
          </Button>
          <span>
            第 {page} / {totalPages} 页
          </span>
          <Button
            variant="secondary"
            disabled={page >= totalPages}
            onClick={() =>
              void loadJobs(page + 1).catch((err) => toast(normalizeApiError(err).message, 'error'))
            }
          >
            下一页
          </Button>
        </div>
        <p className="sa-muted">
          导出文件不自动失效，仅经鉴权后台下载，URL 不可连续可猜（FR-EXP-005）。
        </p>
      </Card>

      {/* 敏感导出二次确认（AC-17） */}
      <Modal
        open={confirmOpen}
        title="敏感导出二次确认"
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <Button
              variant="danger"
              loading={creating}
              onClick={() => pendingScope && void doCreate(pendingScope, true)}
            >
              确认导出个人信息
            </Button>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
          </>
        }
      >
        <p className="sa-confirm-warning sa-confirm-warning-high" role="alert">
          即将导出包含姓名、手机号等直接身份信息的文件。请确认导出目的合法合规，并妥善保管导出文件。
        </p>
        <p>
          导出范围：{pendingScope ? scopeSummary(pendingScope, orgNameOf(scopeOrgId), activityTitleOf(scopeActivityId)) : '—'}
        </p>
        <p className="sa-muted">本次敏感导出将记录操作者、范围与时间并写入审计日志（FR-EXP-003、FR-AUD-004）。</p>
      </Modal>
    </SuperLayout>
  );
}
