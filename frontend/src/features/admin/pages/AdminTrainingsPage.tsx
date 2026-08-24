import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { AdminAccountRecord, TrainingRecord, TrainingStatus } from '../../../shared/api/types';
import { adminAuth } from '../../../shared/auth';
import { normalizeApiError } from '../../../shared/api/http';
import { Button, Card, Input, Loading, Modal } from '../../../shared/ui';
import { AdminLayout } from '../components/AdminLayout';
import { StatusTag, type StatusTone } from '../components/StatusTag';
import { adminCollections } from '../lib/api';
import { TRAINING_STATUS_LABELS } from '../lib/labels';
import { formatDateTime, fromInputDateTime, toInputDateTime } from '../lib/format';

const STATUS_TONES: Record<TrainingStatus, StatusTone> = {
  draft: 'neutral',
  published: 'success',
  closed: 'warning',
};

/**
 * 培训列表（/admin/trainings）。
 * 本机构培训（机构隔离由服务端规则强制），含状态筛选与创建入口；
 * 创建走 trainings 集合 API（createRule 限定本机构），初始状态显式传 draft
 * （guards 强制创建即草稿，同 ActivityForm），checkin_qr_token 由服务端生成（防伪造/防覆盖），前端不传。
 */
export function AdminTrainingsPage() {
  const [items, setItems] = useState<TrainingRecord[] | null>(null);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | TrainingStatus>('');
  const [showCreate, setShowCreate] = useState(false);

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    // 竞态保护：连续切换筛选/刷新时仅最后一次响应生效，避免旧响应覆盖新状态
    const seq = ++loadSeq.current;
    setError('');
    try {
      const filter = statusFilter ? `status = "${statusFilter}"` : undefined;
      const list = await adminCollections().trainings.getFullList({
        sort: '-created',
        filter,
      });
      if (seq !== loadSeq.current) return;
      setItems(list);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(normalizeApiError(err).message);
      setItems([]);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AdminLayout
      title="培训管理"
      actions={<Button onClick={() => setShowCreate(true)}>创建培训</Button>}
    >
      <div className="admin-toolbar">
        <div className="cc-field">
          <label className="cc-label" htmlFor="training-status-filter">
            状态筛选
          </label>
          <select
            id="training-status-filter"
            className="admin-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as '' | TrainingStatus)}
          >
            <option value="">全部状态</option>
            {Object.entries(TRAINING_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <Button variant="secondary" onClick={() => void load()}>
          刷新
        </Button>
      </div>

      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
      {items === null && !error ? <Loading fullscreen label="培训加载中…" /> : null}
      {items !== null && items.length === 0 && !error ? (
        <p className="admin-empty">暂无培训，点击右上角「创建培训」开始。</p>
      ) : null}
      {items && items.length > 0 ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>标题</th>
                <th>代码</th>
                <th>状态</th>
                <th>时间</th>
                <th>地点</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td>
                    <code>{t.training_code}</code>
                  </td>
                  <td>
                    <StatusTag label={TRAINING_STATUS_LABELS[t.status]} tone={STATUS_TONES[t.status]} />
                  </td>
                  <td>
                    {formatDateTime(t.start_time)}
                    <br />
                    <span className="admin-muted">至 {formatDateTime(t.end_time)}</span>
                  </td>
                  <td>{t.location || '—'}</td>
                  <td>
                    <Link to={`/admin/trainings/${t.id}`}>
                      <Button variant="secondary">管理</Button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Modal open={showCreate} title="创建培训" onClose={() => setShowCreate(false)}>
        <TrainingCreateForm
          onSaved={() => {
            setShowCreate(false);
            void load();
          }}
          onCancel={() => setShowCreate(false)}
        />
      </Modal>

      <Card className="admin-section">
        <p className="admin-muted">
          培训与活动解绑：创建后为草稿，发布后参与者扫码签到；报名聆听者并通过审核的账号才能签到成功。
          培训通过为账号级标记，全平台通用。
        </p>
      </Card>
    </AdminLayout>
  );
}

/** 培训创建表单（仅创建；编辑不开放——培训字段稳定，发布后不可改基本信息）。 */
function TrainingCreateForm({
  onSaved,
  onCancel,
}: {
  onSaved: (training: TrainingRecord) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [trainingCode, setTrainingCode] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [startTime, setStartTime] = useState(toInputDateTime(undefined));
  const [endTime, setEndTime] = useState(toInputDateTime(undefined));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError('');
    const nextErrors: Record<string, string> = {};

    if (!title.trim()) nextErrors.title = '请输入培训标题';
    if (!trainingCode.trim()) nextErrors.training_code = '请输入培训代码（如 TR_202608_01）';
    const start = fromInputDateTime(startTime);
    const end = fromInputDateTime(endTime);
    if (!start) nextErrors.start_time = '请选择开始时间';
    if (!end) nextErrors.end_time = '请选择结束时间';
    if (start && end && start >= end) nextErrors.end_time = '结束时间须晚于开始时间';

    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;

    const admin = adminAuth.record as AdminAccountRecord | null;
    if (!admin) return;
    setSubmitting(true);
    try {
      // status 显式传 draft（守卫要求创建即草稿，同 ActivityForm），checkin_qr_token 由服务端生成不传
      const saved = await adminCollections().trainings.create({
        organization_id: admin.organization_id,
        title: title.trim(),
        training_code: trainingCode.trim(),
        description: description.trim() || undefined,
        location: location.trim() || undefined,
        start_time: start,
        end_time: end,
        status: 'draft',
      });
      onSaved(saved);
    } catch (err) {
      setSubmitError(normalizeApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="admin-form-grid">
        <Input
          label="培训标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={errors.title}
          required
        />
        <Input
          label="培训代码"
          value={trainingCode}
          onChange={(e) => setTrainingCode(e.target.value)}
          error={errors.training_code}
          hint="如 TR_202608_01，全局唯一"
          required
        />
        <Input
          label="开始时间"
          type="datetime-local"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          error={errors.start_time}
          required
        />
        <Input
          label="结束时间"
          type="datetime-local"
          value={endTime}
          onChange={(e) => setEndTime(e.target.value)}
          error={errors.end_time}
          required
        />
        <Input label="地点" value={location} onChange={(e) => setLocation(e.target.value)} />
      </div>
      <div className="admin-section">
        <Input
          label="培训描述"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {submitError ? (
        <p className="cc-error" role="alert">
          {submitError}
        </p>
      ) : null}
      <div className="admin-row-actions admin-section">
        <Button type="submit" loading={submitting}>
          创建培训
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
      </div>
    </form>
  );
}
