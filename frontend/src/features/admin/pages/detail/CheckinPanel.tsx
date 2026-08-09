import { useCallback, useEffect, useState } from 'react';
import type {
  ActivityRecord,
  CheckinRecord,
  CheckinSessionRecord,
  RegistrationRecord,
} from '../../../../shared/api/types';
import { normalizeApiError } from '../../../../shared/api/http';
import { Button, Card, Loading, Modal } from '../../../../shared/ui';
import { QrDisplay } from '../../components/QrDisplay';
import { ReasonModal } from '../../components/ReasonModal';
import { StatusTag } from '../../components/StatusTag';
import {
  adminCollections,
  closeCheckin,
  fetchManualCheckinCandidates,
  manualCheckin,
  openCheckin,
  revokeCheckin,
  type ManualCheckinCandidate,
} from '../../lib/api';
import { CHECKIN_SOURCE_LABELS, CHECKIN_STATUS_LABELS, ACTIVITY_ROLE_LABELS } from '../../lib/labels';
import { formatDateTime, shortId } from '../../lib/format';

/**
 * 签到管理台（活动详情子页，FR-CHK-001~006）。
 *
 * - 固定二维码：内容恒为 /checkin/:token 链接（token = 服务端生成的 activity.checkin_qr_token，
 *   不暴露活动 id），全活动周期不变；有效性由「签到开放状态」控制而非二维码本身（FR-CHK-001/002）。
 * - 开放/关闭：走 POST /api/cc/activities/:id/checkin/open|close（可重复，PRD §5.5）；
 *   当前状态以「是否存在 open 的 checkin_sessions 行」判定。
 * - 补签/撤销：reason 必填 + 写审计（FR-CHK-005、AC-10），撤销只改状态不删行（无硬删除）。
 */
export function CheckinPanel({
  activity,
  onChanged,
}: {
  activity: ActivityRecord;
  onChanged: () => Promise<void> | void;
}) {
  const [session, setSession] = useState<CheckinSessionRecord | null>(null);
  const [checkins, setCheckins] = useState<CheckinRecord[] | null>(null);
  const [approved, setApproved] = useState<RegistrationRecord[]>([]);
  const [candidates, setCandidates] = useState<ManualCheckinCandidate[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<CheckinRecord | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [manualParticipant, setManualParticipant] = useState('');
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const cc = adminCollections();
      const [sessions, checkinList, approvedList, candidateList] = await Promise.all([
        cc.checkinSessions.getFullList({
          filter: `activity_id = "${activity.id}" && status = "open"`,
        }),
        cc.checkins.getFullList({
          filter: `activity_id = "${activity.id}"`,
          sort: '-checked_in_at',
        }),
        cc.registrations.getFullList({
          filter: `activity_id = "${activity.id}" && status = "approved"`,
          fields: 'id,participant_id,activity_role',
        }),
        fetchManualCheckinCandidates(activity.id),
      ]);
      // 同一活动同一时间至多一条 open 记录（服务端事务保证）
      setSession(sessions[0] ?? null);
      setCheckins(checkinList);
      setApproved(approvedList);
      setCandidates(candidateList);
    } catch (err) {
      setError(normalizeApiError(err).message);
    }
  }, [activity.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const validCheckins = (checkins ?? []).filter((c) => c.status === 'valid');
  // 补签候选：已通过且当前无有效签到（按用户名展示，候选人名单由服务端注入）
  const manualCandidates = candidates.filter(
    (cand) => !validCheckins.some((c) => c.participant_id === cand.participant_id),
  );

  const toggleSession = async () => {
    setBusy(true);
    setActionError('');
    try {
      if (session) {
        await closeCheckin(activity.id);
      } else {
        await openCheckin(activity.id);
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
      await revokeCheckin(revokeTarget.id, reason);
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
      await manualCheckin({
        activity_id: activity.id,
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

  const checkinUrl = activity.checkin_qr_token
    ? `${window.location.origin}/checkin/${activity.checkin_qr_token}`
    : '';

  return (
    <div>
      <div className="admin-form-grid">
        <Card title="固定签到二维码">
          {checkinUrl ? (
            <QrDisplay
              url={checkinUrl}
              caption="二维码内容固定不变；未开放签到时扫码无效（FR-CHK-001/002）"
              downloadName={`签到二维码-${activity.activity_code}.png`}
            />
          ) : (
            <p className="admin-muted">
              签到二维码 token 缺失（checkin_qr_token 由服务端在活动创建时生成），请刷新重试或联系平台管理员。
            </p>
          )}
        </Card>
        <Card
          title="签到开放控制"
          actions={
            <Button onClick={() => void toggleSession()} loading={busy} variant={session ? 'danger' : 'primary'}>
              {session ? '关闭签到' : '开放签到'}
            </Button>
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
          <p>
            已签到<strong> {validCheckins.length} </strong>人 / 已通过报名 {approved.length} 人
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
        {checkins === null && !error ? <Loading label="签到名单加载中…" /> : null}
        {checkins !== null && checkins.length === 0 && !error ? (
          <p className="admin-empty">暂无签到记录。</p>
        ) : null}
        {checkins && checkins.length > 0 ? (
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
                {checkins.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <code title={c.participant_id}>{shortId(c.participant_id)}</code>
                    </td>
                    <td>{CHECKIN_SOURCE_LABELS[c.source]}</td>
                    <td>
                      <StatusTag
                        label={CHECKIN_STATUS_LABELS[c.status]}
                        tone={c.status === 'valid' ? 'success' : 'danger'}
                      />
                    </td>
                    <td>{formatDateTime(c.checked_in_at)}</td>
                    <td className="admin-muted">{c.reason || '—'}</td>
                    <td>
                      {c.status === 'valid' ? (
                        <Button
                          variant="danger"
                          onClick={() => {
                            setActionError('');
                            setRevokeTarget(c);
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
        <p className="admin-muted">撤销保留原记录（状态置为已撤销）并写入审计（FR-CHK-005）。</p>
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
          <label className="cc-label" htmlFor="manual-participant">
            选择参与者（已通过报名且未签到）
            <span className="cc-required" aria-hidden="true">
              *
            </span>
          </label>
          <select
            id="manual-participant"
            className="admin-select"
            value={manualParticipant}
            onChange={(e) => setManualParticipant(e.target.value)}
          >
            <option value="">请选择</option>
            {manualCandidates.map((cand) => (
              <option key={cand.participant_id} value={cand.participant_id}>
                {cand.username}（{ACTIVITY_ROLE_LABELS[cand.activity_role]}）
              </option>
            ))}
          </select>
          {manualCandidates.length === 0 ? (
            <p className="cc-hint">暂无可补签的参与者（均已签到或无已通过报名）。</p>
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

/** 补签原因表单（reason 必填，FR-CHK-005）。 */
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
      <label className="cc-label" htmlFor="manual-reason">
        补签原因
        <span className="cc-required" aria-hidden="true">
          *
        </span>
      </label>
      <textarea
        id="manual-reason"
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
