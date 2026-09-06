import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  ActivityRecord,
  ActivityStatus,
  OrganizationRecord,
} from '../../../shared/api/types';
import { normalizeApiError } from '../../../shared/api/http';
import { Button, Card, Loading, Modal } from '../../../shared/ui';
import { AdminLayout } from '../components/AdminLayout';
import { ActivityForm } from '../components/ActivityForm';
import { StatusTag, type StatusTone } from '../components/StatusTag';
import { RegistrationPanel } from './detail/RegistrationPanel';
import { CheckinPanel } from './detail/CheckinPanel';
import { SurveyPanel } from './detail/SurveyPanel';
import { LifecyclePanel } from './detail/LifecyclePanel';
import { OnsitePanel } from './detail/OnsitePanel';
import { adminCollections, runActivityAction } from '../lib/api';
import { ACTIVITY_STATUS_LABELS } from '../lib/labels';
import { formatDateTime } from '../lib/format';
import {
  ADMIN_ACTIVITY_ACTION_LABELS,
  availableActivityActions,
  capacityOf,
  countApproved,
  remainingCapacity,
  type AdminActivityAction,
  type ApprovedCounts,
} from '../lib/rules';

const STATUS_TONES: Record<ActivityStatus, StatusTone> = {
  draft: 'neutral',
  pending_review: 'info',
  rejected: 'danger',
  published: 'success',
  closed: 'warning',
  taken_down: 'danger',
  archived: 'neutral',
};

type DetailTab = 'registrations' | 'checkin' | 'surveys' | 'onsite' | 'settings';

const TAB_LABELS: Record<DetailTab, string> = {
  registrations: '报名审核',
  checkin: '签到管理',
  surveys: '问卷管理',
  onsite: '现场工作台',
  settings: '活动设置',
};

const ZERO_COUNTS: ApprovedCounts = { total: 0, speaker: 0, listener: 0 };

/** 动作确认文案（发布/关闭/归档/提交审核均无需原因；驳回与下架为超管动作不在本端）。 */
const ACTION_CONFIRM_TEXT: Record<AdminActivityAction, string> = {
  'submit-review': '提交后活动进入平台审核，审核期间不可编辑发布。确认提交？',
  publish: '发布后活动详情页公开可见，且可按配置开放报名。确认发布？',
  close: '关闭后报名与签到停止，活动进入已关闭状态。确认关闭？',
  archive: '归档后活动只读保留，可继续导出数据。确认归档？',
};

/**
 * 活动详情管理（/admin/activities/:activityId）。
 * 头部：状态 + 生命周期动作（按状态机与机构发布审核开关计算可用性，PRD §4.3、FR-ACT-004）；
 * 生命周期面板（T4，PRD §4.2）：按招募中/活动前/现场中/活动后展示下一步操作，位于标签页之上；
 * 子页：报名审核 / 签到管理 / 问卷管理 / 现场工作台（T4，PRD §4.3 实时六区域 + 配对管理）/
 * 活动设置（编辑 + 报名表配置）。
 */
export function AdminActivityDetailPage() {
  const { activityId = '' } = useParams();
  const [activity, setActivity] = useState<ActivityRecord | null>(null);
  const [org, setOrg] = useState<OrganizationRecord | null>(null);
  const [counts, setCounts] = useState<ApprovedCounts>(ZERO_COUNTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<DetailTab>('registrations');
  const [pendingAction, setPendingAction] = useState<AdminActivityAction | null>(null);
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const cc = adminCollections();
      const record = await cc.activities.getOne(activityId);
      setActivity(record);
      if (record.is_template) setTab((current) => current === 'surveys' ? current : 'settings');
      const [orgRecord, approved] = await Promise.all([
        cc.organizations.getOne(record.organization_id),
        cc.registrations.getFullList({
          filter: `activity_id = "${record.id}" && status = "approved"`,
          fields: 'id,activity_role',
        }),
      ]);
      setOrg(orgRecord);
      setCounts(countApproved(approved.map((r) => r.activity_role)));
    } catch (err) {
      setError(normalizeApiError(err).message);
    } finally {
      setLoading(false);
    }
  }, [activityId]);

  useEffect(() => {
    void load();
  }, [load]);

  const remaining = useMemo(
    () => (activity ? remainingCapacity(capacityOf(activity), counts) : null),
    [activity, counts],
  );

  const actions = activity && org && !activity.is_template ? availableActivityActions(activity.status, org.require_activity_approval) : [];

  const confirmAction = async () => {
    if (!activity || !pendingAction) return;
    setActionSubmitting(true);
    setActionError('');
    try {
      await runActivityAction(activity.id, pendingAction);
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
      <AdminLayout title="活动详情">
        <Loading fullscreen label="活动加载中…" />
      </AdminLayout>
    );
  }

  if (error || !activity) {
    return (
      <AdminLayout title="活动详情">
        <p className="cc-error" role="alert">
          {error || '活动不存在或无权访问'}
        </p>
        <Link to="/admin/activities">返回活动列表</Link>
      </AdminLayout>
    );
  }

  const publicUrl = `${window.location.origin}/a/${activity.id}`;

  return (
    <AdminLayout
      title={activity.title}
      actions={
        <div className="admin-row-actions">
          {actions.map((action) => (
            <Button
              key={action}
              variant={action === 'archive' || action === 'close' ? 'secondary' : 'primary'}
              onClick={() => {
                setActionError('');
                setPendingAction(action);
              }}
            >
              {ADMIN_ACTIVITY_ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      }
    >
      {activity.is_template ? <p role="note">这是机构模板，只保存配置和问卷。请回到活动列表选择“从模板创建活动”，新活动调整时间后再发布。</p> : null}
      <Card>
        <div className="admin-stats">
          <span>
            状态：
            <StatusTag label={ACTIVITY_STATUS_LABELS[activity.status]} tone={STATUS_TONES[activity.status]} />
          </span>
          <span>
            代码：<code>{activity.activity_code}</code>
          </span>
          <span>
            时间：{formatDateTime(activity.start_time)} ~ {formatDateTime(activity.end_time)}
          </span>
          {activity.location ? <span>地点：{activity.location}</span> : null}
        </div>
        <div className="admin-stats admin-section">
          <span>
            总名额<strong>
              {counts.total}/{activity.capacity_total}
            </strong>
            （剩余 {remaining?.total ?? '—'}）
          </span>
          <span>
            倾诉者<strong>
              {counts.speaker}/{activity.capacity_speaker}
            </strong>
            （剩余 {remaining?.speaker ?? '—'}）
          </span>
          <span>
            聆听者<strong>
              {counts.listener}/{activity.capacity_listener}
            </strong>
            （剩余 {remaining?.listener ?? '—'}）
          </span>
        </div>
        {activity.status === 'published' || activity.status === 'closed' ? (
          <p className="admin-muted admin-section">
            公开链接：<code>{publicUrl}</code>（活动不进入公开列表，仅链接/二维码可达，FR-ACT-002）
          </p>
        ) : null}
        {activity.status === 'pending_review' ? (
          <p className="admin-muted admin-section">已提交平台审核，请等待超级管理员批准或驳回。</p>
        ) : null}
        {activity.status === 'taken_down' ? (
          <p className="admin-muted admin-section">活动已被平台下架，公开入口不可访问，历史数据保留。</p>
        ) : null}
      </Card>

      {org && !activity.is_template ? (
        <LifecyclePanel activity={activity} org={org} counts={counts} onOpenTab={setTab} />
      ) : null}

      <div className="admin-tabs" role="tablist">
        {(Object.keys(TAB_LABELS) as DetailTab[]).filter((key) => !activity.is_template || key === 'settings' || key === 'surveys').map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`admin-tab${tab === key ? ' admin-tab-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {TAB_LABELS[key]}
          </button>
        ))}
      </div>

      {tab === 'registrations' && remaining ? (
        <RegistrationPanel
          activity={activity}
          counts={counts}
          remaining={remaining}
          onChanged={load}
        />
      ) : null}
      {tab === 'checkin' ? <CheckinPanel activity={activity} onChanged={load} /> : null}
      {tab === 'surveys' ? <SurveyPanel activity={activity} /> : null}
      {tab === 'onsite' ? <OnsitePanel activity={activity} onOpenTab={setTab} /> : null}
      {tab === 'settings' ? (
        <Card title="编辑活动">
          <ActivityForm mode="edit" initial={activity} approvedCounts={counts} onSaved={() => void load()} />
        </Card>
      ) : null}

      <Modal
        open={pendingAction !== null}
        title={pendingAction ? ADMIN_ACTIVITY_ACTION_LABELS[pendingAction] : ''}
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
