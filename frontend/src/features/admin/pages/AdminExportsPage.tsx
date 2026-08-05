import { useCallback, useEffect, useState } from 'react';
import type {
  ActivityRecord,
  ExportJobRecord,
  OrganizationRecord,
} from '../../../shared/api/types';
import { normalizeApiError } from '../../../shared/api/http';
import { adminAuth } from '../../../shared/auth';
import type { AdminAccountRecord } from '../../../shared/api/types';
import { Button, Card, Loading, Modal } from '../../../shared/ui';
import { AdminLayout } from '../components/AdminLayout';
import { StatusTag } from '../components/StatusTag';
import { adminCollections, createExport, downloadExport } from '../lib/api';
import { EXPORT_STATUS_LABELS } from '../lib/labels';
import { formatDateTime } from '../lib/format';

/**
 * 本机构导出（/admin/exports，FR-EXP-001~005、AC-16/17）。
 *
 * - 范围：本机构全部 或 本机构单活动（服务端按身份校验范围交集，FR-EXP-004）；
 * - 普通导出按 is_sensitive 标记过滤；敏感导出 = 普通导出 + 个人信息字段，
 *   需机构开关（allow_sensitive_export）+ 主动选择 + 二次确认 + 审计（FR-EXP-003、AC-17）；
 * - 导出记录含导出人/范围/时间/是否含个人信息（PRD §10.3）；
 *   文件不自动失效，鉴权下载（FR-EXP-005）。
 */
export function AdminExportsPage() {
  const [org, setOrg] = useState<OrganizationRecord | null>(null);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [jobs, setJobs] = useState<ExportJobRecord[] | null>(null);
  const [loadError, setLoadError] = useState('');

  const [scopeType, setScopeType] = useState<'organization' | 'activity'>('organization');
  const [scopeActivityId, setScopeActivityId] = useState('');
  const [includePii, setIncludePii] = useState(false);
  const [showPiiConfirm, setShowPiiConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [downloadingId, setDownloadingId] = useState('');

  const sensitiveAllowed = org?.allow_sensitive_export === true;

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

  const doCreate = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      await createExport({
        scope:
          scopeType === 'activity'
            ? { type: 'activity', activity_id: scopeActivityId }
            : { type: 'organization' },
        include_pii: includePii,
        confirm: true,
      });
      setShowPiiConfirm(false);
      setIncludePii(false);
      await load();
    } catch (err) {
      setSubmitError(normalizeApiError(err).message);
      setShowPiiConfirm(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreate = () => {
    setSubmitError('');
    if (scopeType === 'activity' && !scopeActivityId) {
      setSubmitError('请选择要导出的活动');
      return;
    }
    if (includePii) {
      // 敏感导出：二次确认（AC-17）
      setShowPiiConfirm(true);
      return;
    }
    void doCreate();
  };

  const handleDownload = async (job: ExportJobRecord) => {
    setDownloadingId(job.id);
    setSubmitError('');
    try {
      await downloadExport(job.id, `chatcircle-export-${job.id}.zip`);
    } catch (err) {
      setSubmitError(normalizeApiError(err).message);
    } finally {
      setDownloadingId('');
    }
  };

  const activityTitle = (id?: string) => activities.find((a) => a.id === id)?.title ?? id ?? '—';

  return (
    <AdminLayout title="本机构导出">
      <Card title="新建导出任务">
        <div className="cc-field">
          <span className="cc-label">导出范围</span>
          <label className="admin-checkbox-row">
            <input
              type="radio"
              name="export-scope"
              checked={scopeType === 'organization'}
              onChange={() => setScopeType('organization')}
            />
            本机构全部数据
          </label>
          <label className="admin-checkbox-row">
            <input
              type="radio"
              name="export-scope"
              checked={scopeType === 'activity'}
              onChange={() => setScopeType('activity')}
            />
            单个活动
          </label>
          {scopeType === 'activity' ? (
            <select
              className="admin-select"
              aria-label="选择活动"
              value={scopeActivityId}
              onChange={(e) => setScopeActivityId(e.target.value)}
            >
              <option value="">请选择活动</option>
              {activities.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}（{a.activity_code}）
                </option>
              ))}
            </select>
          ) : null}
        </div>

        <label className="admin-checkbox-row">
          <input
            type="checkbox"
            checked={includePii}
            disabled={!sensitiveAllowed}
            onChange={(e) => setIncludePii(e.target.checked)}
          />
          包含个人信息字段（敏感导出）
        </label>
        {!sensitiveAllowed ? (
          <p className="admin-muted">
            本机构未开启敏感导出开关（allow_sensitive_export），如需导出个人信息请联系平台超级管理员开启（FR-ORG-005、AC-17）。
          </p>
        ) : (
          <p className="admin-muted">
            普通导出按 is_sensitive 标记排除/掩码敏感字段（不含用户名等身份信息，FR-EXP-002）；
            敏感导出将包含被标记的个人信息字段，需二次确认并写入审计。
          </p>
        )}

        {submitError ? (
          <p className="cc-error" role="alert">
            {submitError}
          </p>
        ) : null}
        <Button onClick={handleCreate} loading={submitting}>
          创建导出任务
        </Button>
      </Card>

      <Card title="导出记录" className="admin-section" actions={<Button variant="secondary" onClick={() => void load()}>刷新</Button>}>
        {loadError ? (
          <p className="cc-error" role="alert">
            {loadError}
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
                    <td>
                      {job.scope_json.type === 'organization'
                        ? '本机构全部'
                        : job.scope_json.type === 'activity'
                          ? `单活动：${activityTitle(job.scope_json.activity_id)}`
                          : job.scope_json.type}
                    </td>
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
                          下载 ZIP
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

      <Modal
        open={showPiiConfirm}
        title="敏感导出二次确认"
        onClose={() => setShowPiiConfirm(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowPiiConfirm(false)} disabled={submitting}>
              取消
            </Button>
            <Button variant="danger" onClick={() => void doCreate()} loading={submitting}>
              确认导出含个人信息数据
            </Button>
          </>
        }
      >
        <p>
          敏感导出将包含被标记为敏感的个人信息字段（如报名敏感字段答案）。请确认：
        </p>
        <ul>
          <li>导出目的正当，且已获知平台隐私口径（平台非完全匿名系统，PRD §11.1）；</li>
          <li>导出文件仅授权人员可访问，妥善保管、用后及时清理；</li>
          <li>本次敏感导出将写入审计日志（导出人、范围、时间，FR-EXP-003）。</li>
        </ul>
      </Modal>
    </AdminLayout>
  );
}
