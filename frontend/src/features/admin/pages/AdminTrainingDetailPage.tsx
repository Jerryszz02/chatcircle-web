import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { TrainingRecord, TrainingStatus } from '../../../shared/api/types';
import { normalizeApiError } from '../../../shared/api/http';
import { Button, Card, Loading, Modal } from '../../../shared/ui';
import { AdminLayout } from '../components/AdminLayout';
import { StatusTag, type StatusTone } from '../components/StatusTag';
import { TrainingCheckinPanel } from './detail/TrainingCheckinPanel';
import { adminCollections, runTrainingAction, type AdminTrainingAction } from '../lib/api';
import { TRAINING_STATUS_LABELS } from '../lib/labels';
import { formatDateTime } from '../lib/format';

const STATUS_TONES: Record<TrainingStatus, StatusTone> = {
  draft: 'neutral',
  published: 'success',
  closed: 'warning',
};

/** 培训状态机：draft→published→closed（不可逆；动作可用性按当前状态计算）。 */
function availableTrainingActions(status: TrainingStatus): AdminTrainingAction[] {
  if (status === 'draft') return ['publish'];
  if (status === 'published') return ['close'];
  return [];
}

const ACTION_LABELS: Record<AdminTrainingAction, string> = {
  publish: '发布培训',
  close: '关闭培训',
};

const ACTION_CONFIRM_TEXT: Record<AdminTrainingAction, string> = {
  publish: '发布后聆听者可看到本培训并可扫码签到。确认发布？',
  close: '关闭后签到停止，培训进入已关闭状态。确认关闭？',
};

/**
 * 培训详情管理（/admin/trainings/:trainingId）。
 * 头部：状态 + 生命周期动作（发布/关闭，走 /api/cc/trainings/:id/* 端点，写审计）；
 * 主体：基本信息 + 签到管理台（二维码 / 开放控制 / 名单 / 补签 / 撤销）。
 */
export function AdminTrainingDetailPage() {
  const { trainingId = '' } = useParams();
  const [training, setTraining] = useState<TrainingRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingAction, setPendingAction] = useState<AdminTrainingAction | null>(null);
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const record = await adminCollections().trainings.getOne(trainingId);
      setTraining(record);
    } catch (err) {
      setError(normalizeApiError(err).message);
    } finally {
      setLoading(false);
    }
  }, [trainingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const actions = training ? availableTrainingActions(training.status) : [];

  const confirmAction = async () => {
    if (!training || !pendingAction) return;
    setActionSubmitting(true);
    setActionError('');
    try {
      await runTrainingAction(training.id, pendingAction);
      setPendingAction(null);
      await load();
    } catch (err) {
      setActionError(normalizeApiError(err).message);
    } finally {
      setActionSubmitting(false);
    }
  };

  if (loading) {
    return (
      <AdminLayout title="培训详情">
        <Loading fullscreen label="培训加载中…" />
      </AdminLayout>
    );
  }

  if (error || !training) {
    return (
      <AdminLayout title="培训详情">
        <p className="cc-error" role="alert">
          {error || '培训不存在或无权访问'}
        </p>
        <Link to="/admin/trainings">返回培训列表</Link>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={training.title}
      actions={
        <div className="admin-row-actions">
          {actions.map((action) => (
            <Button
              key={action}
              variant={action === 'close' ? 'secondary' : 'primary'}
              onClick={() => {
                setActionError('');
                setPendingAction(action);
              }}
            >
              {ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      }
    >
      <Card>
        <div className="admin-stats">
          <span>
            状态：
            <StatusTag label={TRAINING_STATUS_LABELS[training.status]} tone={STATUS_TONES[training.status]} />
          </span>
          <span>
            代码：<code>{training.training_code}</code>
          </span>
          <span>
            时间：{formatDateTime(training.start_time)} ~ {formatDateTime(training.end_time)}
          </span>
          {training.location ? <span>地点：{training.location}</span> : null}
        </div>
        {training.description ? (
          <p className="admin-muted admin-section">{training.description}</p>
        ) : null}
        {training.status === 'draft' ? (
          <p className="admin-muted admin-section">培训为草稿，发布后聆听者才能在培训页看到并扫码签到。</p>
        ) : null}
      </Card>

      <div className="admin-section">
        <TrainingCheckinPanel training={training} onChanged={load} />
      </div>

      <Modal
        open={pendingAction !== null}
        title={pendingAction ? ACTION_LABELS[pendingAction] : ''}
        onClose={() => setPendingAction(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingAction(null)} disabled={actionSubmitting}>
              取消
            </Button>
            <Button onClick={() => void confirmAction()} loading={actionSubmitting}>
              确认
            </Button>
          </>
        }
      >
        <p>{pendingAction ? ACTION_CONFIRM_TEXT[pendingAction] : ''}</p>
        {actionError ? (
          <p className="cc-error" role="alert">
            {actionError}
          </p>
        ) : null}
      </Modal>
    </AdminLayout>
  );
}
