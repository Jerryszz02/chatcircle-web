import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ActivityLiveSummaryResponse } from '../../../../shared/api/accountEvent';
import type {
  ActivityRecord,
  CheckinRecord,
  OrganizationRecord,
  RegistrationRecord,
} from '../../../../shared/api/types';
import { normalizeApiError } from '../../../../shared/api/http';
import { Button, Card, Loading } from '../../../../shared/ui';
import { adminCollections, fetchActivityLiveSummary } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { parseFormConfig, type ApprovedCounts } from '../../lib/rules';
import {
  buildRegistrationTrend,
  buildSurveyReminder,
  buildWeComNotice,
  deriveActivityStage,
  formatCompletion,
  formatPercent,
  LIFECYCLE_STAGE_LABELS,
  type ActivityLifecycleStage,
} from '../../lib/workbench';

/** 生命周期面板能切换到的详情页子页签。 */
export type LifecycleTargetTab = 'registrations' | 'checkin' | 'surveys' | 'onsite' | 'settings';

const STAGE_TONES: Record<ActivityLifecycleStage, string> = {
  setup: 'admin-badge',
  recruiting: 'admin-badge admin-badge-info',
  pre_event: 'admin-badge admin-badge-warn',
  onsite: 'admin-badge admin-badge-info',
  post_event: 'admin-badge',
};

/**
 * 活动生命周期面板（PRD §4.2）：详情页在标签页之上按生命周期展示「下一步操作」。
 *
 * - 招募中：报名趋势、待审核数（前往批量审核）、角色名额、联系名单导出入口；
 * - 活动前：已通过人数/预计到场、缺少必填资料、微信群通知文案（可复制）、现场准备检查清单；
 * - 现场中：签到/配对/问卷统一进入「现场工作台」；
 * - 活动后：问卷催办（可复制文案）、数据质量检查、导出入口、复盘摘要与归档提示。
 *
 * 数据：报名/签到走集合 API（机构隔离由服务端 rules 强制），现场指标复用 T3
 * live-summary 一次性快照（实时刷新在「现场工作台」页签内）。
 */
export function LifecyclePanel({
  activity,
  org,
  counts,
  onOpenTab,
}: {
  activity: ActivityRecord;
  org: OrganizationRecord;
  counts: ApprovedCounts;
  onOpenTab: (tab: LifecycleTargetTab) => void;
}) {
  const [registrations, setRegistrations] = useState<RegistrationRecord[] | null>(null);
  const [checkins, setCheckins] = useState<CheckinRecord[] | null>(null);
  const [snapshot, setSnapshot] = useState<ActivityLiveSummaryResponse | null>(null);
  const [fullNameMissing, setFullNameMissing] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [copiedKey, setCopiedKey] = useState('');

  useEffect(() => {
    let cancelled = false;
    setError('');
    (async () => {
      try {
        const cc = adminCollections();
        const [regs, checkinList, summary, fullNameDefs] = await Promise.all([
          cc.registrations.getFullList({
            filter: `activity_id = "${activity.id}"`,
            fields: 'id,participant_id,activity_role,status,submitted_at',
          }),
          cc.checkins.getFullList({ filter: `activity_id = "${activity.id}"`, fields: 'id,status' }),
          fetchActivityLiveSummary(activity.id),
          cc.registrationFieldDefs.getFullList({
            filter: 'field_code = "FULL_NAME" && status = "active"',
            fields: 'id',
          }),
        ]);
        if (cancelled) return;
        setRegistrations(regs);
        setCheckins(checkinList);
        setSnapshot(summary);

        // 缺少必填资料：FULL_NAME 标准字段存在且本活动启用必填时，统计已通过报名中缺答人数
        const fullNameDef = fullNameDefs[0];
        const config = parseFormConfig(activity.form_config_json);
        const fullNameCfg = fullNameDef
          ? config.fields.find((f) => f.field_def_id === fullNameDef.id)
          : undefined;
        if (fullNameDef && fullNameCfg?.enabled && fullNameCfg.required) {
          const answers = await cc.registrationAnswers.getFullList({
            filter: `field_def_id = "${fullNameDef.id}" && registration_id.activity_id = "${activity.id}"`,
            fields: 'registration_id',
          });
          if (cancelled) return;
          const answered = new Set(answers.map((a) => a.registration_id));
          setFullNameMissing(
            regs.filter((r) => r.status === 'approved' && !answered.has(r.id)).length,
          );
        } else {
          setFullNameMissing(null);
        }
      } catch (err) {
        if (!cancelled) setError(normalizeApiError(err).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activity]);

  const stage = deriveActivityStage(activity, new Date(), counts.total);
  const pendingCount = (registrations ?? []).filter((r) => r.status === 'pending').length;
  const trend = useMemo(() => buildRegistrationTrend(registrations ?? []), [registrations]);
  const trendMax = Math.max(1, ...trend.map((p) => p.count));
  const revokedCount = (checkins ?? []).filter((c) => c.status === 'revoked').length;
  const validCount = (checkins ?? []).filter((c) => c.status === 'valid').length;
  const fieldConfig = parseFormConfig(activity.form_config_json);
  const enabledFieldCount = fieldConfig.fields.filter((f) => f.enabled).length;

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? '' : prev)), 2000);
    } catch {
      setCopiedKey('');
    }
  };

  return (
    <Card
      className="admin-section"
      title={`当前阶段：${LIFECYCLE_STAGE_LABELS[stage]}`}
      actions={<span className={STAGE_TONES[stage]}>{LIFECYCLE_STAGE_LABELS[stage]}</span>}
    >
      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
      {registrations === null && !error ? <Loading label="阶段信息加载中…" /> : null}

      {registrations !== null && stage === 'setup' ? (
        <div>
          <p className="admin-muted">活动尚未发布。建议按以下顺序准备：</p>
          <ul className="admin-note-list">
            <li>在「活动设置」完善活动信息与报名表配置（建议启用并必填「姓名」标准字段）。</li>
            <li>在「问卷管理」从模板创建活动问卷。</li>
            <li>通过页面右上角动作{orgRequireApprovalText(org)}。</li>
          </ul>
        </div>
      ) : null}

      {registrations !== null && stage === 'recruiting' ? (
        <div>
          <div className="admin-stats">
            <span>
              待审核<strong>{pendingCount}</strong> 人
            </span>
            <span>
              已通过<strong>{counts.total}</strong> 人（倾诉者 {counts.speaker} / 聆听者 {counts.listener}）
            </span>
            <span>
              剩余名额：总 {Math.max(0, activity.capacity_total - counts.total)} · 倾诉者{' '}
              {Math.max(0, activity.capacity_speaker - counts.speaker)} · 聆听者{' '}
              {Math.max(0, activity.capacity_listener - counts.listener)}
            </span>
          </div>
          <div className="admin-section">
            <p className="admin-muted">报名趋势（近 14 天，按提交时间计）</p>
            <div className="admin-trend" role="img" aria-label="近 14 天报名趋势图">
              {trend.map((point) => (
                <div key={point.date} className="admin-trend-bar" title={`${point.date}：${point.count} 人`}>
                  <span>{point.count > 0 ? point.count : ''}</span>
                  <div
                    className="admin-trend-bar-fill"
                    style={{ height: `${Math.max(2, (point.count / trendMax) * 48)}px` }}
                  />
                  <span>{point.label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="admin-row-actions admin-section">
            <Button onClick={() => onOpenTab('registrations')}>前往报名审核{pendingCount > 0 ? `（${pendingCount} 条待审核）` : ''}</Button>
            <Link to="/admin/exports">
              <Button variant="secondary">导出联系名单</Button>
            </Link>
          </div>
        </div>
      ) : null}

      {registrations !== null && stage === 'pre_event' ? (
        <div>
          <div className="admin-stats">
            <span>
              已通过<strong>{counts.total}</strong> 人（预计到场以此为上限）
            </span>
            {fullNameMissing !== null ? (
              <span>
                缺少必填「姓名」资料<strong>{fullNameMissing}</strong> 人
              </span>
            ) : null}
          </div>
          <div className="admin-section">
            <p className="admin-muted">现场准备检查清单：</p>
            <ul className="admin-note-list">
              <li>{enabledFieldCount > 0 ? '✓' : '⚠️'} 报名表字段已配置（当前启用 {enabledFieldCount} 个）</li>
              <li>
                {(snapshot?.surveys.length ?? 0) > 0 ? '✓' : '⚠️'} 活动问卷已创建（当前{' '}
                {snapshot?.surveys.length ?? 0} 份）
              </li>
              <li>{activity.checkin_qr_token ? '✓' : '⚠️'} 固定签到二维码已生成（见「签到管理」）</li>
              <li>✓ 活动已发布，公开报名链接可用</li>
            </ul>
          </div>
          <div className="admin-section">
            <label className="cc-label" htmlFor="wecom-notice">
              微信群通知文案（可复制到群内；本期不自动发送，专项 PRD §13）
            </label>
            <textarea
              id="wecom-notice"
              className="cc-input cc-textarea"
              rows={5}
              readOnly
              value={buildWeComNotice(activity, counts.total)}
            />
            <div className="admin-row-actions">
              <Button
                variant="secondary"
                onClick={() => void copyText('notice', buildWeComNotice(activity, counts.total))}
              >
                {copiedKey === 'notice' ? '已复制' : '复制通知文案'}
              </Button>
              <Button variant="secondary" onClick={() => onOpenTab('onsite')}>
                进入现场工作台
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {registrations !== null && stage === 'onsite' ? (
        <div>
          {snapshot ? (
            <div className="admin-stats">
              <span>
                有效签到<strong>{snapshot.checkins.valid.total}</strong> / 已通过{' '}
                {snapshot.checkins.approved.total} 人（签到率 {formatPercent(snapshot.checkins.rate.total)}）
              </span>
              <span>
                已配对<strong>{snapshot.pairings.active_pairs}</strong> 组 · 等待{' '}
                {snapshot.pairings.waiting.total} 人
              </span>
            </div>
          ) : null}
          <div className="admin-row-actions admin-section">
            <Button onClick={() => onOpenTab('onsite')}>进入现场工作台</Button>
            <Button variant="secondary" onClick={() => onOpenTab('checkin')}>
              签到管理
            </Button>
          </div>
          <p className="admin-muted admin-section">
            签到、配对、问卷完成与异常处理统一在「现场工作台」实时跟踪（PRD §4.2/§4.3）。
          </p>
        </div>
      ) : null}

      {registrations !== null && stage === 'post_event' ? (
        <div>
          {snapshot ? (
            <div>
              <p className="admin-muted">复盘摘要（总体口径）：</p>
              <div className="admin-stats">
                <span>
                  已通过<strong>{snapshot.registrations.approved.total}</strong> 人 · 有效签到{' '}
                  <strong>{snapshot.checkins.valid.total}</strong> 人（签到率{' '}
                  {formatPercent(snapshot.checkins.rate.total)}）
                </span>
                <span>
                  完成配对<strong>{snapshot.pairings.active_pairs}</strong> 组
                </span>
              </div>
              {snapshot.surveys.length > 0 ? (
                <ul className="admin-note-list">
                  {snapshot.surveys.map((s) => (
                    <li key={s.activity_survey_id}>
                      {s.title}：总体完成 {formatCompletion(s.overall_completion)}，未完成{' '}
                      {Math.max(0, s.overall_completion.eligible - s.overall_completion.submitted)} 人
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <div className="admin-section">
            <p className="admin-muted">数据质量检查：</p>
            <ul className="admin-note-list">
              <li>
                {validCount <= counts.total ? '✓' : '⚠️'} 有效签到 {validCount} 人 / 已通过 {counts.total} 人
                {validCount > counts.total ? '（签到数超过已通过数，请检查是否有报名被回退）' : ''}
              </li>
              <li>{revokedCount === 0 ? '✓' : 'ℹ️'} 已撤销签到 {revokedCount} 条（撤销保留记录并写审计）</li>
            </ul>
          </div>
          <div className="admin-section">
            <p className="admin-muted">问卷催办（复制文案后发往微信群）：</p>
            {(snapshot?.surveys ?? []).filter(
              (s) => s.overall_completion.eligible - s.overall_completion.submitted > 0,
            ).length === 0 ? (
              <p className="admin-muted">各问卷均已收齐或暂无符合资格参与者。</p>
            ) : (
              <div className="admin-row-actions">
                {(snapshot?.surveys ?? [])
                  .filter((s) => s.overall_completion.eligible - s.overall_completion.submitted > 0)
                  .map((s) => (
                    <Button
                      key={s.activity_survey_id}
                      variant="secondary"
                      onClick={() =>
                        void copyText(s.activity_survey_id, buildSurveyReminder(activity.title, s.title))
                      }
                    >
                      {copiedKey === s.activity_survey_id ? '已复制' : `复制「${s.title}」催办文案`}
                    </Button>
                  ))}
              </div>
            )}
          </div>
          <div className="admin-row-actions admin-section">
            <Link to="/admin/exports">
              <Button variant="secondary">导出活动数据</Button>
            </Link>
            <Button variant="secondary" onClick={() => onOpenTab('surveys')}>
              问卷管理
            </Button>
          </div>
          <p className="admin-muted admin-section">
            数据核对无误后可在页面右上角执行归档（closed → archived，PRD §4.3）。
            {activity.end_time ? `活动结束于 ${formatDateTime(activity.end_time)}。` : ''}
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function orgRequireApprovalText(org: OrganizationRecord): string {
  return org.require_activity_approval ? '「提交平台审核」' : '「直接发布」';
}
