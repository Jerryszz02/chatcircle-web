import { useCallback, useEffect, useState } from 'react';
import type {
  TrainingAttendanceRecord,
  TrainingCheckinSessionRecord,
  TrainingRecord,
} from '../../../../shared/api/types';
import { normalizeApiError } from '../../../../shared/api/http';
import { Button, Card, Loading, Modal } from '../../../../shared/ui';
import { QrDisplay } from '../../components/QrDisplay';
import { ReasonModal } from '../../components/ReasonModal';
import { StatusTag } from '../../components/StatusTag';
import {
  adminCollections,
  closeTrainingCheckin,
  fetchManualTrainingCheckinCandidates,
  manualTrainingCheckin,
  openTrainingCheckin,
  revokeTrainingCheckin,
  type ManualTrainingCheckinCandidate,
} from '../../lib/api';
import { CHECKIN_SOURCE_LABELS, CHECKIN_STATUS_LABELS } from '../../lib/labels';
import { formatDateTime, shortId } from '../../lib/format';

/**
 * 培训签到管理台（培训详情子页，结构照搬活动签到 CheckinPanel）。
 *
 * - 固定二维码：内容恒为 /training-checkin/:token 链接（token = 服务端生成的
 *   training.checkin_qr_token，不暴露培训 id），全培训周期不变；
 *   有效性由「签到开放状态」与培训状态（published）控制而非二维码本身。
 * - 开放/关闭：走 POST /api/cc/trainings/:id/checkin/open|close；
 *   当前状态以「是否存在 open 的 training_checkin_sessions 行」判定。
 * - 补签/撤销：reason 必填 + 写审计，撤销只改状态不删行（无硬删除）。
 * - 签到资格（存在已通过的聆听者报名）由服务端在自助签到端点强制。
 */
export function TrainingCheckinPanel({
  training,
  onChanged,
}: {
  training: TrainingRecord;
  onChanged: () => Promise<void> | void;
}) {
  const [session, setSession] = useState<TrainingCheckinSessionRecord | null>(null);
  const [attendances, setAttendances] = useState<TrainingAttendanceRecord[] | null>(null);
  const [candidates, setCandidates] = useState<ManualTrainingCheckinCandidate[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<TrainingAttendanceRecord | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [manualParticipant, setManualParticipant] = useState('');
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const cc = adminCollections();
      const [sessions, attendanceList, candidateList] = await Promise.all([
        cc.trainingCheckinSessions.getFullList({
          filter: `training_id = "${training.id}" && status = "open"`,
        }),
        cc.trainingAttendances.getFullList({
          filter: `training_id = "${training.id}"`,
          sort: '-checked_in_at',
        }),
        fetchManualTrainingCheckinCandidates(training.id),
      ]);
      // 同一培训同一时间至多一条 open 记录（服务端事务保证）
      setSession(sessions[0] ?? null);
      setAttendances(attendanceList);
      setCandidates(candidateList);
    } catch (err) {
      setError(normalizeApiError(err).message);
    }
  }, [training.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const validAttendances = (attendances ?? []).filter((a) => a.status === 'valid');
  // 补签候选：当前无有效签到（候选人名单由服务端注入，含用户名）
  const manualCandidates = candidates.filter(
    (cand) => !validAttendances.some((a) => a.participant_id === cand.participant_id),
  );
  // 名单展示优先用候选人里的用户名，未知时回退短 id（管理员不可读参与者集合）
  const usernameById = new Map(candidates.map((c) => [c.participant_id, c.username]));

  const published = training.status === 'published';

  const toggleSession = async () => {
    setBusy(true);
    setActionError('');
    try {
      if (session) {
        await closeTrainingCheckin(training.id);
      } else {
        await openTrainingCheckin(training.id);
      }
      await load();
    } catch (err) {
      setActionError(normalizeApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const submitRevoke = async (reason: string) => {
    if (!revokeTarget) return;
    setBusy(true);
    try {
      await revokeTrainingCheckin(revokeTarget.id, reason);
      setRevokeTarget(null);
      await load();
    } catch (err) {
      setActionError(normalizeApiError(err).message);
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const submitManual = async (reason: string) => {
    if (!manualParticipant) {
      setActionError('请选择要补签的参与者');
      return;
    }
    setBusy(true);
    try {
      await manualTrainingCheckin({
        training_id: training.id,
        participant_id: manualParticipant,
        reason,
      });
      setShowManual(false);
      setManualParticipant('');
      await Promise.all([load(), onChanged()]);
    } catch (err) {
      setActionError(normalizeApiError(err).message);
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const checkinUrl = training.checkin_qr_token
    ? `${window.location.origin}/training-checkin/${training.checkin_qr_token}`
    : '';

  return (
    <div>
      <div className="admin-form-grid">
        <Card title="固定签到二维码">
          {checkinUrl ? (
            <QrDisplay
              url={checkinUrl}
              caption="二维码内容固定不变；培训未发布或未开放签到时扫码无效"
              downloadName={`培训签到二维码-${training.training_code}.png`}
            />
          ) : (
            <p className="admin-muted">
              签到二维码 token 缺失（checkin_qr_token 由服务端在培训创建时生成），请刷新重试或联系平台管理员。
            </p>
          )}
        </Card>
        <Card
          title="签到开放控制"
          actions={
            published ? (
              <Button
                onClick={() => void toggleSession()}
                loading={busy}
                variant={session ? 'danger' : 'primary'}
              >
                {session ? '关闭签到' : '开放签到'}
              </Button>
            ) : undefined
          }
        >
          <p>
            当前状态：
            {session ? (
              <StatusTag label="已开放" tone="success" />
            ) : (
              <StatusTag label="未开放" tone="neutral" />
            )}
          </p>
          {session ? (
            <p className="admin-muted">开放时间：{formatDateTime(session.opened_at)}</p>
          ) : null}
          {!published ? (
            <p className="admin-muted">
              {training.status === 'draft' ? '培训发布后（右上角「发布」）才能开放签到。' : '培训已关闭，不能再开放签到。'}
            </p>
          ) : null}
          <p>
            已签到<strong> {validAttendances.length} </strong>人
          </p>
          <div className="admin-row-actions">
            <Button variant="secondary" onClick={() => void load()}>
              刷新名单
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setActionError('');
                setShowManual(true);
              }}
            >
              管理员补签
            </Button>
          </div>
          {actionError ? (
            <p className="cc-error" role="alert">
              {actionError}
            </p>
          ) : null}
        </Card>
      </div>

      <Card title="签到名单" className="admin-section">
        {error ? (
          <p className="cc-error" role="alert">
            {error}
          </p>
        ) : null}
        {attendances === null && !error ? <Loading label="签到名单加载中…" /> : null}
        {attendances !== null && attendances.length === 0 && !error ? (
          <p className="admin-empty">暂无签到记录。</p>
        ) : null}
        {attendances && attendances.length > 0 ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>参与者</th>
                  <th>来源</th>
                  <th>状态</th>
                  <th>签到时间</th>
                  <th>原因</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {attendances.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {usernameById.get(a.participant_id) ?? (
                        <code title={a.participant_id}>{shortId(a.participant_id)}</code>
                      )}
                    </td>
                    <td>{CHECKIN_SOURCE_LABELS[a.source]}</td>
                    <td>
                      <StatusTag
                        label={CHECKIN_STATUS_LABELS[a.status]}
                        tone={a.status === 'valid' ? 'success' : 'danger'}
                      />
                    </td>
                    <td>{formatDateTime(a.checked_in_at)}</td>
                    <td className="admin-muted">{a.reason || '—'}</td>
                    <td>
                      {a.status === 'valid' ? (
                        <Button
                          variant="danger"
                          onClick={() => {
                            setActionError('');
                            setRevokeTarget(a);
                          }}
                        >
                          撤销
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <ReasonModal
        open={revokeTarget !== null}
        title="撤销签到"
        confirmLabel="确认撤销"
        confirmVariant="danger"
        reasonRequired
        reasonLabel="撤销原因"
        submitting={busy}
        onClose={() => setRevokeTarget(null)}
        onSubmit={submitRevoke}
      >
        <p className="admin-muted">撤销保留原记录（状态置为已撤销）并写入审计。</p>
        {actionError ? (
          <p className="cc-error" role="alert">
            {actionError}
          </p>
        ) : null}
      </ReasonModal>

      <Modal
        open={showManual}
        title="管理员补签"
        onClose={() => setShowManual(false)}
        footer={null}
      >
        <div className="cc-field">
          <label className="cc-label" htmlFor="manual-training-participant">
            选择参与者（未签到）
            <span className="cc-required" aria-hidden="true">
              *
            </span>
          </label>
          <select
            id="manual-training-participant"
            className="admin-select"
            value={manualParticipant}
            onChange={(e) => setManualParticipant(e.target.value)}
          >
            <option value="">请选择</option>
            {manualCandidates.map((cand) => (
              <option key={cand.participant_id} value={cand.participant_id}>
                {cand.username}
              </option>
            ))}
          </select>
          {manualCandidates.length === 0 ? (
            <p className="cc-hint">暂无可补签的参与者。</p>
          ) : null}
        </div>
        <ReasonForm
          submitting={busy}
          disabled={!manualParticipant}
          onSubmit={submitManual}
          onCancel={() => setShowManual(false)}
        />
        {actionError ? (
          <p className="cc-error" role="alert">
            {actionError}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}

/** 补签原因表单（reason 必填）。 */
function ReasonForm({
  submitting,
  disabled,
  onSubmit,
  onCancel,
}: {
  submitting: boolean;
  disabled: boolean;
  onSubmit: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError('补签原因必填');
      return;
    }
    setError('');
    try {
      await onSubmit(trimmed);
      setReason('');
    } catch {
      // 错误信息由父级展示
    }
  };

  return (
    <div className="cc-field">
      <label className="cc-label" htmlFor="manual-training-reason">
        补签原因
        <span className="cc-required" aria-hidden="true">
          *
        </span>
      </label>
      <textarea
        id="manual-training-reason"
        className="cc-input cc-textarea"
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="admin-row-actions">
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button onClick={() => void submit()} loading={submitting} disabled={disabled}>
          确认补签
        </Button>
      </div>
    </div>
  );
}
