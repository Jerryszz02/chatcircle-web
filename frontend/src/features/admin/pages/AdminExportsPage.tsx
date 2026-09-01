import { useCallback, useEffect, useState } from 'react';
import type {
  ActivityRecord,
  ExportJobRecord,
  OrganizationRecord,
} from '../../../shared/api/types';
import { readExportJobScope } from '../../../shared/api/exportJobScope';
import { normalizeApiError } from '../../../shared/api/http';
import { adminAuth } from '../../../shared/auth';
import type { AdminAccountRecord } from '../../../shared/api/types';
import { Button, Card, Loading } from '../../../shared/ui';
import { AdminLayout } from '../components/AdminLayout';
import { StatusTag } from '../components/StatusTag';
import { ExportWizard } from '../components/ExportWizard';
import { adminCollections, downloadExport } from '../lib/api';
import { EXPORT_STATUS_LABELS } from '../lib/labels';
import { formatDateTime } from '../lib/format';

/**
 * 本机构导出（/admin/exports，PRD §7、api-design §6、FR-EXP-001~005、AC-16/17）。
 *
 * - 新建导出走 T6 五步向导（范围 → 数据域 → 行筛选 → 字段 → 格式），
 *   先 preview（服务端判敏 + 预估行数）后创建；敏感导出需机构开关 +
 *   二次确认 + 审计（FR-EXP-003、AC-17），判敏权威在服务端；
 * - 导出记录含导出人/范围/时间/是否含个人信息（PRD §10.3）；
 *   scope_json 读取经 readExportJobScope 兼容 v1 扁平形状与 v2 存储形状；
 * - 文件不自动失效，鉴权下载（FR-EXP-005）；xlsx/csv_zip 按存储格式命名。
 */
export function AdminExportsPage() {
  const [org, setOrg] = useState<OrganizationRecord | null>(null);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [jobs, setJobs] = useState<ExportJobRecord[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [downloadingId, setDownloadingId] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const admin = adminAuth.record as AdminAccountRecord | null;
      const cc = adminCollections();
      const [orgRecord, activityList, jobList] = await Promise.all([
        admin ? cc.organizations.getOne(admin.organization_id) : Promise.resolve(null),
        cc.activities.getFullList({ sort: '-created', fields: 'id,title,activity_code' }),
        cc.exportJobs.getFullList({ sort: '-created' }),
      ]);
      setOrg(orgRecord);
      setActivities(activityList);
      setJobs(jobList);
    } catch (err) {
      setLoadError(normalizeApiError(err).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDownload = async (job: ExportJobRecord) => {
    setDownloadingId(job.id);
    setActionError('');
    try {
      const ext = readExportJobScope(job.scope_json).format === 'xlsx' ? 'xlsx' : 'zip';
      await downloadExport(job.id, `chatcircle-export-${job.id}.${ext}`);
    } catch (err) {
      setActionError(normalizeApiError(err).message);
    } finally {
      setDownloadingId('');
    }
  };

  const scopeLabel = (job: ExportJobRecord) => {
    const scope = readExportJobScope(job.scope_json);
    if (scope.type === 'organization') return '本机构全部';
    if (scope.type === 'activity') {
      const title = activities.find((a) => a.id === scope.activity_id)?.title;
      return `单活动：${title ?? scope.activity_id}`;
    }
    return scope.type ?? '—';
  };

  return (
    <AdminLayout title="本机构导出">
      <Card title="新建导出任务">
        <ExportWizard org={org} activities={activities} onCreated={() => void load()} />
      </Card>

      <Card title="导出记录" className="admin-section" actions={<Button variant="secondary" onClick={() => void load()}>刷新</Button>}>
        {loadError ? (
          <p className="cc-error" role="alert">
            {loadError}
          </p>
        ) : null}
        {actionError ? (
          <p className="cc-error" role="alert">
            {actionError}
          </p>
        ) : null}
        {jobs === null && !loadError ? <Loading label="导出记录加载中…" /> : null}
        {jobs !== null && jobs.length === 0 && !loadError ? (
          <p className="admin-empty">暂无导出记录。</p>
        ) : null}
        {jobs && jobs.length > 0 ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>创建时间</th>
                  <th>范围</th>
                  <th>格式</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>导出人</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{formatDateTime(job.created)}</td>
                    <td>{scopeLabel(job)}</td>
                    <td>{readExportJobScope(job.scope_json).format === 'xlsx' ? 'XLSX' : 'CSV ZIP'}</td>
                    <td>
                      {job.include_pii ? (
                        <StatusTag label="敏感" tone="danger" />
                      ) : (
                        <StatusTag label="普通" tone="neutral" />
                      )}
                    </td>
                    <td>
                      <StatusTag
                        label={EXPORT_STATUS_LABELS[job.status]}
                        tone={job.status === 'done' ? 'success' : job.status === 'failed' ? 'danger' : 'info'}
                      />
                    </td>
                    <td>
                      <code className="admin-muted">{job.created_by}</code>
                    </td>
                    <td>
                      {job.status === 'done' ? (
                        <Button
                          variant="secondary"
                          loading={downloadingId === job.id}
                          onClick={() => void handleDownload(job)}
                        >
                          下载
                        </Button>
                      ) : (
                        <span className="admin-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </AdminLayout>
  );
}
