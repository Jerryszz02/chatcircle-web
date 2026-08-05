import { useCallback, useEffect, useState } from 'react';
import type {
  ActivityRecord,
  ActivityRole,
  RegistrationAnswerRecord,
  RegistrationFieldDefRecord,
  RegistrationRecord,
  RegistrationStatus,
} from '../../../../shared/api/types';
import { normalizeApiError } from '../../../../shared/api/http';
import { Button, Card, Loading, Modal } from '../../../../shared/ui';
import { ReasonModal } from '../../components/ReasonModal';
import { StatusTag, type StatusTone } from '../../components/StatusTag';
import { adminCollections, transitionRegistration } from '../../lib/api';
import {
  ACTIVITY_ROLE_LABELS,
  REGISTRATION_STATUS_LABELS,
  SOURCE_TYPE_LABELS,
} from '../../lib/labels';
import { formatDateTime, shortId } from '../../lib/format';
import {
  canTransitionRegistration,
  transitionRequiresReason,
  validateTransitionForm,
  type ApprovedCounts,
  type RemainingCapacity,
} from '../../lib/rules';

const STATUS_TONES: Record<RegistrationStatus, StatusTone> = {
  pending: 'info',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
};

interface TransitionTarget {
  registration: RegistrationRecord;
  to: RegistrationStatus;
}

/** 弹窗标题按迁移语义生成（pending→approved 为审核，rejected/cancelled→approved 为回退）。 */
function transitionTitle(registration: RegistrationRecord, to: RegistrationStatus): string {
  if (to === 'approved') {
    return registration.status === 'pending' ? '审核通过' : '回退为通过';
  }
  return to === 'rejected' ? '拒绝报名' : '取消报名';
}

/**
 * 报名审核台（活动详情子页）。
 *
 * - 迁移动作严格按 PRD §4.4 矩阵渲染（pending→approved/rejected；approved→cancelled；
 *   rejected/cancelled→approved 回退），矩阵外无入口；
 * - 取消与回退强制填写原因（FR-REG-008），审核通过/回退时可同时调整角色（FR-REG-005）；
 * - 角色剩余名额随操作刷新显示（服务端事务硬校验兜底，AC-08）；
 * - 参与者以 participant_id 标识展示（管理员不可读参与者账号表，见 collection rules；
 *   与导出主键口径一致，PRD §9.2）。
 */
export function RegistrationPanel({
  activity,
  counts,
  remaining,
  onChanged,
}: {
  activity: ActivityRecord;
  counts: ApprovedCounts;
  remaining: RemainingCapacity;
  onChanged: () => Promise<void> | void;
}) {
  const [statusTab, setStatusTab] = useState<RegistrationStatus>('pending');
  const [items, setItems] = useState<RegistrationRecord[] | null>(null);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<TransitionTarget | null>(null);
  const [targetRole, setTargetRole] = useState<ActivityRole>('speaker');
  const [formErrors, setFormErrors] = useState<{ reason?: string; activity_role?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [answersFor, setAnswersFor] = useState<RegistrationRecord | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const list = await adminCollections().registrations.getFullList({
        filter: `activity_id = "${activity.id}" && status = "${statusTab}"`,
        sort: '-submitted_at',
      });
      setItems(list);
    } catch (err) {
      setError(normalizeApiError(err).message);
      setItems([]);
    }
  }, [activity.id, statusTab]);

  useEffect(() => {
    void load();
  }, [load]);

  const openTransition = (registration: RegistrationRecord, to: RegistrationStatus) => {
    setFormErrors({});
    setTargetRole(registration.activity_role);
    setTarget({ registration, to });
  };

  const submitTransition = async (reason: string) => {
    if (!target) return;
    const { registration, to } = target;
    const activityRole = to === 'approved' ? targetRole : undefined;
    const errors = validateTransitionForm(registration.status, registration.activity_role, { to, reason, activity_role: activityRole }, remaining);
    setFormErrors(errors);
    if (Object.values(errors).some(Boolean)) return;
    setSubmitting(true);
    try {
      await transitionRegistration(registration.id, { to, reason: reason || undefined, activity_role: activityRole });
      setTarget(null);
      await Promise.all([load(), onChanged()]);
    } catch (err) {
      setFormErrors({ reason: normalizeApiError(err).message });
      throw err;
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <Card title="名额与审核">
        <div className="admin-stats">
          <span>
            已通过<strong>{counts.total}</strong> 人（倾诉者 {counts.speaker} / 聆听者 {counts.listener}）
          </span>
          <span>
            剩余名额：总<strong>{remaining.total}</strong> · 倾诉者
            <strong>{remaining.speaker}</strong> · 聆听者<strong>{remaining.listener}</strong>
          </span>
          <Button variant="secondary" onClick={() => void Promise.all([load(), onChanged()])}>
            刷新
          </Button>
        </div>
      </Card>

      <div className="admin-tabs" role="tablist" aria-label="报名状态筛选">
        {(Object.keys(REGISTRATION_STATUS_LABELS) as RegistrationStatus[]).map((status) => (
          <button
            key={status}
            type="button"
            role="tab"
            aria-selected={statusTab === status}
            className={`admin-tab${statusTab === status ? ' admin-tab-active' : ''}`}
            onClick={() => setStatusTab(status)}
          >
            {REGISTRATION_STATUS_LABELS[status]}
          </button>
        ))}
      </div>

      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
      {items === null && !error ? <Loading label="报名加载中…" /> : null}
      {items !== null && items.length === 0 && !error ? (
        <p className="admin-empty">当前状态下暂无报名记录。</p>
      ) : null}
      {items && items.length > 0 ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>参与者</th>
                <th>角色</th>
                <th>提交时间</th>
                <th>状态</th>
                <th>最近原因</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((reg) => (
                <tr key={reg.id}>
                  <td>
                    <code title={reg.participant_id}>{shortId(reg.participant_id)}</code>
                  </td>
                  <td>{ACTIVITY_ROLE_LABELS[reg.activity_role]}</td>
                  <td>{formatDateTime(reg.submitted_at)}</td>
                  <td>
                    <StatusTag label={REGISTRATION_STATUS_LABELS[reg.status]} tone={STATUS_TONES[reg.status]} />
                  </td>
                  <td className="admin-muted">{reg.status_reason || '—'}</td>
                  <td>
                    <div className="admin-row-actions">
                      <Button variant="secondary" onClick={() => setAnswersFor(reg)}>
                        报名详情
                      </Button>
                      {canTransitionRegistration(reg.status, 'approved') ? (
                        <Button onClick={() => openTransition(reg, 'approved')}>
                          {reg.status === 'pending' ? '通过' : '回退为通过'}
                        </Button>
                      ) : null}
                      {canTransitionRegistration(reg.status, 'rejected') ? (
                        <Button variant="danger" onClick={() => openTransition(reg, 'rejected')}>
                          拒绝
                        </Button>
                      ) : null}
                      {canTransitionRegistration(reg.status, 'cancelled') ? (
                        <Button variant="danger" onClick={() => openTransition(reg, 'cancelled')}>
                          取消
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <ReasonModal
        open={target !== null}
        title={target ? transitionTitle(target.registration, target.to) : ''}
        confirmLabel="确认"
        confirmVariant={target?.to === 'approved' ? 'primary' : 'danger'}
        reasonRequired={target ? transitionRequiresReason(target.registration.status, target.to) : false}
        reasonLabel="原因"
        submitting={submitting}
        onClose={() => setTarget(null)}
        onSubmit={submitTransition}
      >
        {target?.to === 'approved' ? (
          <div className="cc-field">
            <label className="cc-label" htmlFor="transition-role">
              活动角色（审核时可调整）
            </label>
            <select
              id="transition-role"
              className="admin-select"
              value={targetRole}
              onChange={(e) => setTargetRole(e.target.value as ActivityRole)}
            >
              {(Object.keys(ACTIVITY_ROLE_LABELS) as ActivityRole[]).map((role) => (
                <option key={role} value={role}>
                  {ACTIVITY_ROLE_LABELS[role]}（剩余 {role === 'speaker' ? remaining.speaker : remaining.listener}）
                </option>
              ))}
            </select>
            {formErrors.activity_role ? (
              <p className="cc-error" role="alert">
                {formErrors.activity_role}
              </p>
            ) : null}
          </div>
        ) : null}
        {formErrors.reason ? (
          <p className="cc-error" role="alert">
            {formErrors.reason}
          </p>
        ) : null}
      </ReasonModal>

      <AnswersModal registration={answersFor} onClose={() => setAnswersFor(null)} />
    </div>
  );
}

/** 报名字段答案只读查看（管理员审核依据；敏感答案不进入任何日志，PRD §11.2）。 */
function AnswersModal({
  registration,
  onClose,
}: {
  registration: RegistrationRecord | null;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<
    | { label: string; value: string; sensitive: boolean; source: string }[]
    | null
  >(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!registration) {
      setRows(null);
      setError('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cc = adminCollections();
        const answers: RegistrationAnswerRecord[] = await cc.registrationAnswers.getFullList({
          filter: `registration_id = "${registration.id}"`,
        });
        const defs: RegistrationFieldDefRecord[] = await cc.registrationFieldDefs.getFullList();
        const defById = new Map(defs.map((d) => [d.id, d]));
        if (cancelled) return;
        setRows(
          answers.map((a) => {
            const def = defById.get(a.field_def_id);
            return {
              label: def?.label ?? a.field_def_id,
              value: formatAnswerValue(a.value_json),
              sensitive: def?.is_sensitive ?? false,
              source: def ? SOURCE_TYPE_LABELS[def.source_type] : '—',
            };
          }),
        );
      } catch (err) {
        if (!cancelled) setError(normalizeApiError(err).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [registration]);

  return (
    <Modal open={registration !== null} title="报名详情" onClose={onClose}>
      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
      {rows === null && !error ? <Loading label="答案加载中…" /> : null}
      {rows && rows.length === 0 ? <p className="admin-empty">无报名答案。</p> : null}
      {rows && rows.length > 0 ? (
        <table className="admin-table">
          <thead>
            <tr>
              <th>字段</th>
              <th>答案</th>
              <th>标记</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td>{row.label}</td>
                <td>{row.value}</td>
                <td>
                  {row.sensitive ? <StatusTag label="敏感" tone="danger" /> : null}
                  <span className="admin-muted"> {row.source}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Modal>
  );
}

/** 答案值展示：多选 JSON 数组以顿号连接，其余直接字符串化。 */
function formatAnswerValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join('、');
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
