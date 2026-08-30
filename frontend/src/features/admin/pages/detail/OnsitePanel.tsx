import { useEffect, useMemo, useState } from 'react';
import {
  STANDARD_REGISTRATION_FIELDS,
  type ActivityLiveSummaryResponse,
} from '../../../../shared/api/accountEvent';
import type {
  ActivityRecord,
  ActivitySurveyRecord,
  CheckinRecord,
  CheckinSessionRecord,
  RegistrationRecord,
} from '../../../../shared/api/types';
import { adminAuth } from '../../../../shared/auth';
import { normalizeApiError } from '../../../../shared/api/http';
import { Button, Card, Loading } from '../../../../shared/ui';
import { ReasonModal } from '../../components/ReasonModal';
import { StatusTag } from '../../components/StatusTag';
import {
  subscribeActivityLiveSummary,
  type ActivityLiveConnectionStatus,
} from '../../lib/activityLive';
import {
  adminCollections,
  closeCheckin,
  openCheckin,
  reassignActivityPairing,
  runSurveyAction,
  startActivityPairings,
} from '../../lib/api';
import { formatDateTime, shortId } from '../../lib/format';
import { CHECKIN_STATUS_LABELS, SURVEY_STATUS_LABELS } from '../../lib/labels';
import { availableSurveyActions } from '../../lib/rules';
import {
  buildWeComNotice,
  buildWorkbenchCsv,
  computeStructureExtras,
  formatCompletion,
  formatPercent,
} from '../../lib/workbench';
import type { ActivityPairRecord } from '../../../../shared/api/accountEvent';

/**
 * 现场工作台（活动详情「现场工作台」页签，PRD §4.3 + T4 管理员配对界面）。
 *
 * - 六个区域严格按 PRD §4.3 表格：报名漏斗 / 签到 / 配对 / 问卷 / 参与者结构 / 快捷动作；
 * - 数据以 T3 live-summary 快照为唯一事实来源：先订阅六类依赖再拉快照，Realtime 事件
 *   只触发防抖重拉；断线显示离线状态，恢复后由服务层自动重拉整页快照（activityLive.ts）；
 * - 每张卡片显示「最后更新时间」（快照 generated_at）；两个问卷完成率遵守
 *   「分母为 0 显示 —、不超过 100%」口径；聚合分组人数 <5 合并为「样本不足」；
 * - 配对管理：开始配对（幂等）、等待/已配对队列、手工调整（原因必填，走 T2 reassign）。
 */

const GENDER_LABELS = optionLabels('GENDER');
const AGE_RANGE_LABELS = optionLabels('AGE_RANGE');

function optionLabels(fieldCode: 'GENDER' | 'AGE_RANGE'): Record<string, string> {
  const field = STANDARD_REGISTRATION_FIELDS.find((f) => f.field_code === fieldCode);
  const options = field && 'options_json' in field ? field.options_json : undefined;
  const map: Record<string, string> = { unknown: '未填写' };
  for (const option of options ?? []) map[option.value] = option.label;
  return map;
}

function onsiteCodeOf(checkin: CheckinRecord): string {
  if (!checkin.onsite_role || !checkin.onsite_sequence) return '—';
  const prefix = checkin.onsite_role === 'speaker' ? 'S' : 'L';
  return prefix + String(checkin.onsite_sequence).padStart(2, '0');
}

export function OnsitePanel({
  activity,
  onOpenTab,
}: {
  activity: ActivityRecord;
  onOpenTab: (tab: 'checkin') => void;
}) {
  const [snapshot, setSnapshot] = useState<ActivityLiveSummaryResponse | null>(null);
  const [status, setStatus] = useState<ActivityLiveConnectionStatus>('connecting');
  const [error, setError] = useState('');

  const [checkinSession, setCheckinSession] = useState<CheckinSessionRecord | null>(null);
  const [surveys, setSurveys] = useState<ActivitySurveyRecord[]>([]);
  const [registrations, setRegistrations] = useState<RegistrationRecord[]>([]);
  const [orgApproved, setOrgApproved] = useState<RegistrationRecord[]>([]);
  const [actionError, setActionError] = useState('');
  const [actionNote, setActionNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showPairing, setShowPairing] = useState(false);

  // T3：先建立六类依赖订阅再拉快照；事件仅防抖重拉，断线恢复自动重拉整页快照
  useEffect(() => {
    let stopped = false;
    let stop: (() => Promise<void>) | undefined;
    setError('');
    setStatus('connecting');
    subscribeActivityLiveSummary({
      client: adminAuth.client,
      activityId: activity.id,
      onSnapshot: (value) => {
        if (!stopped) setSnapshot(value);
      },
      onStatusChange: (value) => {
        if (!stopped) setStatus(value);
      },
      onError: (err) => {
        if (!stopped) setError(err.message);
      },
    })
      .then((release) => {
        stop = release;
        if (stopped) void release();
      })
      .catch((err) => {
        if (!stopped) {
          setError(normalizeApiError(err).message);
          setStatus('offline');
        }
      });
    return () => {
      stopped = true;
      if (stop) void stop();
    };
  }, [activity.id]);

  // 快照每次更新后顺带刷新快捷动作所需的辅助数据（签到场次/问卷状态/结构聚合底数）
  const refreshKey = snapshot?.generated_at ?? '';
  useEffect(() => {
    if (!refreshKey) return;
    let cancelled = false;
    (async () => {
      try {
        const cc = adminCollections();
        const [sessions, surveyList, regs, orgRegs] = await Promise.all([
          cc.checkinSessions.getFullList({
            filter: `activity_id = "${activity.id}" && status = "open"`,
          }),
          cc.activitySurveys.getFullList({ filter: `activity_id = "${activity.id}"`, sort: 'created' }),
          cc.registrations.getFullList({
            filter: `activity_id = "${activity.id}"`,
            fields: 'id,participant_id,activity_id,status,submitted_at',
          }),
          cc.registrations.getFullList({
            filter: `status = "approved" && activity_id.organization_id = "${activity.organization_id}"`,
            fields: 'id,participant_id,activity_id,status,submitted_at',
          }),
        ]);
        if (cancelled) return;
        setCheckinSession(sessions[0] ?? null);
        setSurveys(surveyList);
        setRegistrations(regs);
        setOrgApproved(orgRegs);
      } catch {
        // 辅助数据失败不打断快照展示；下一轮快照更新会重试
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activity.id, activity.organization_id, refreshKey]);

  const structureExtras = useMemo(
    () => computeStructureExtras(registrations, orgApproved, activity.start_time),
    [registrations, orgApproved, activity.start_time],
  );

  const lastUpdated = snapshot ? formatDateTime(snapshot.generated_at) : '—';

  const toggleCheckin = async () => {
    setBusy(true);
    setActionError('');
    setActionNote('');
    try {
      if (checkinSession) {
        await closeCheckin(activity.id);
        setCheckinSession(null);
        setActionNote('签到已关闭');
      } else {
        await openCheckin(activity.id);
        // checkin_sessions 不在六类快照订阅源内，开放成功后主动重取开放状态
        const sessions = await adminCollections().checkinSessions.getFullList({
          filter: `activity_id = "${activity.id}" && status = "open"`,
        });
        setCheckinSession(sessions[0] ?? null);
        setActionNote('签到已开放');
      }
    } catch (err) {
      setActionError(normalizeApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const startPairing = async () => {
    setBusy(true);
    setActionError('');
    setActionNote('');
    try {
      const res = await startActivityPairings(activity.id);
      setActionNote(
        res.already_started
          ? `配对此前已开始，本次补齐 ${res.created_pairs} 组（当前共 ${res.active_pairs} 组）`
          : `配对已开始，新建 ${res.created_pairs} 组`,
      );
    } catch (err) {
      setActionError(normalizeApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const runSurvey = async (surveyId: string, action: 'open' | 'close') => {
    setBusy(true);
    setActionError('');
    try {
      await runSurveyAction(surveyId, action);
    } catch (err) {
      setActionError(normalizeApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const copyNotice = async () => {
    if (!snapshot) return;
    try {
      await navigator.clipboard.writeText(
        buildWeComNotice(activity, snapshot.registrations.approved.total),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const exportView = () => {
    if (!snapshot) return;
    const csv = buildWorkbenchCsv(snapshot, activity);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `现场工作台-${activity.activity_code}-${snapshot.generated_at.slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      {status === 'offline' ? (
        <p className="cc-error" role="alert">
          实时连接已断开，正在自动重连；恢复后将自动重新拉取整页快照。
        </p>
      ) : null}
      {error && status !== 'offline' ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
      {!snapshot && !error ? <Loading label="现场快照加载中…" /> : null}

      {snapshot ? (
        <div className="admin-workbench-grid">
          <Card title="报名漏斗">
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>总数</th>
                    <th>倾诉者</th>
                    <th>聆听者</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['报名总数', snapshot.registrations.total],
                      ['待审核', snapshot.registrations.pending],
                      ['已通过', snapshot.registrations.approved],
                      ['已拒绝', snapshot.registrations.rejected],
                      ['已取消', snapshot.registrations.cancelled],
                    ] as const
                  ).map(([label, counts]) => (
                    <tr key={label}>
                      <td>{label}</td>
                      <td>{counts.total}</td>
                      <td>{counts.speaker}</td>
                      <td>{counts.listener}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="admin-card-foot">最后更新：{lastUpdated}</p>
          </Card>

          <Card title="签到">
            <div className="admin-stats">
              <span>
                有效签到<strong>{snapshot.checkins.valid.total}</strong> / 已通过{' '}
                {snapshot.checkins.approved.total} 人
              </span>
              <span>
                签到率<strong>{formatPercent(snapshot.checkins.rate.total)}</strong>（倾诉者{' '}
                {formatPercent(snapshot.checkins.rate.speaker)} · 聆听者{' '}
                {formatPercent(snapshot.checkins.rate.listener)}）
              </span>
            </div>
            {snapshot.recent_checkins.length > 0 ? (
              <div className="admin-table-wrap admin-section">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>姓名</th>
                      <th>现场编号</th>
                      <th>状态</th>
                      <th>签到时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.recent_checkins.slice(0, 8).map((c) => (
                      <tr key={c.checkin_id}>
                        <td>{c.display_name || shortId(c.participant_id)}</td>
                        <td>
                          <code>{c.onsite_code || '—'}</code>
                        </td>
                        <td>
                          <StatusTag
                            label={CHECKIN_STATUS_LABELS[c.status]}
                            tone={c.status === 'valid' ? 'success' : 'danger'}
                          />
                        </td>
                        <td>{formatDateTime(c.checked_in_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="admin-muted admin-section">暂无签到记录。</p>
            )}
            <div className="admin-row-actions admin-section">
              <Button variant="secondary" onClick={() => onOpenTab('checkin')}>
                手工补签 / 撤销
              </Button>
            </div>
            <p className="admin-card-foot">最后更新：{lastUpdated}</p>
          </Card>

          <Card title="配对">
            <div className="admin-stats">
              <span>
                已签到：倾诉者<strong>{snapshot.checkins.valid.speaker}</strong> · 聆听者
                <strong>{snapshot.checkins.valid.listener}</strong>
              </span>
              <span>
                已配对<strong>{snapshot.pairings.active_pairs}</strong> 组 · 等待{' '}
                {snapshot.pairings.waiting.total} 人（倾诉者 {snapshot.pairings.waiting.speaker} · 聆听者{' '}
                {snapshot.pairings.waiting.listener}）
              </span>
              <span>
                未平衡差额<strong>{snapshot.pairings.imbalance}</strong>
              </span>
            </div>
            <div className="admin-row-actions admin-section">
              <Button onClick={() => void startPairing()} loading={busy}>
                {snapshot.onsite.pairing_started_at ? '再次补齐配对' : '开始配对'}
              </Button>
              <Button variant="secondary" onClick={() => setShowPairing((v) => !v)}>
                {showPairing ? '收起配对管理' : '配对管理'}
              </Button>
            </div>
            <p className="admin-card-foot">最后更新：{lastUpdated}</p>
          </Card>

          <Card title="问卷">
            {snapshot.surveys.length === 0 ? (
              <p className="admin-muted">暂无问卷。</p>
            ) : (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>问卷</th>
                      <th>现场完成</th>
                      <th>总体完成</th>
                      <th>未完成</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.surveys.map((s) => (
                      <tr key={s.activity_survey_id}>
                        <td>{s.title}</td>
                        <td>{formatCompletion(s.onsite_completion)}</td>
                        <td>{formatCompletion(s.overall_completion)}</td>
                        <td>
                          {Math.max(
                            0,
                            s.onsite_completion.eligible - s.onsite_completion.submitted,
                          )}{' '}
                          人
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="admin-muted admin-section">
              现场完成率分母为当前有效签到且角色符合人数；总体完成率分母为当前已通过且角色符合人数。
              分母为 0 显示「—」。
            </p>
            <p className="admin-card-foot">最后更新：{lastUpdated}</p>
          </Card>

          <Card title="参与者结构">
            <StructureGroup
              title="性别"
              buckets={snapshot.demographics.gender}
              labels={GENDER_LABELS}
            />
            <StructureGroup
              title="年龄段"
              buckets={snapshot.demographics.age_range}
              labels={AGE_RANGE_LABELS}
            />
            <StructureGroup
              title="角色（已通过）"
              buckets={[
                {
                  key: 'speaker',
                  label: '倾诉者',
                  count: snapshot.registrations.approved.speaker,
                  suppressed: false,
                },
                {
                  key: 'listener',
                  label: '聆听者',
                  count: snapshot.registrations.approved.listener,
                  suppressed: false,
                },
              ]}
            />
            <StructureGroup title="新老参与者" buckets={structureExtras.newcomer} />
            <StructureGroup title="历史参与次数" buckets={structureExtras.history} />
            <StructureGroup title="报名提前量" buckets={structureExtras.leadTime} />
            <p className="admin-muted admin-section">
              口径：本场已通过报名（{structureExtras.baseCount} 人）聚合；任一分组人数不足 5
              人时该维度合并为「样本不足」，不做减法反推（PRD §4.3）。
            </p>
            <p className="admin-card-foot">最后更新：{lastUpdated}</p>
          </Card>

          <Card title="快捷动作">
            <div className="admin-row-actions">
              <Button
                variant={checkinSession ? 'danger' : 'primary'}
                onClick={() => void toggleCheckin()}
                loading={busy}
              >
                {checkinSession ? '关闭签到' : '开放签到'}
              </Button>
              <Button variant="secondary" onClick={() => void startPairing()} disabled={busy}>
                开始配对
              </Button>
              <Button variant="secondary" onClick={() => void copyNotice()}>
                {copied ? '已复制' : '复制通知文案'}
              </Button>
              <Button variant="secondary" onClick={exportView}>
                导出当前视图
              </Button>
            </div>
            {surveys.length > 0 ? (
              <div className="admin-table-wrap admin-section">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>问卷</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {surveys.map((survey) => (
                      <tr key={survey.id}>
                        <td>{survey.title}</td>
                        <td>
                          <StatusTag
                            label={SURVEY_STATUS_LABELS[survey.status]}
                            tone={survey.status === 'open' ? 'success' : 'neutral'}
                          />
                        </td>
                        <td>
                          <div className="admin-row-actions">
                            {availableSurveyActions(survey.status).map((action) => (
                              <Button
                                key={action}
                                variant={action === 'close' ? 'danger' : 'secondary'}
                                disabled={busy}
                                onClick={() => void runSurvey(survey.id, action)}
                              >
                                {action === 'open' ? '开放问卷' : '结束问卷'}
                              </Button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {actionNote ? <p className="cc-hint admin-section">{actionNote}</p> : null}
            {actionError ? (
              <p className="cc-error" role="alert">
                {actionError}
              </p>
            ) : null}
            <p className="admin-card-foot">最后更新：{lastUpdated}</p>
          </Card>
        </div>
      ) : null}

      {showPairing && snapshot ? (
        <PairingManager activity={activity} refreshKey={refreshKey} />
      ) : null}
    </div>
  );
}

/** 参与者结构分组条形展示；suppressed 分桶只显示「样本不足」。 */
function StructureGroup({
  title,
  buckets,
  labels,
}: {
  title: string;
  /** 兼容快照的 SuppressedBucket（无 label，经 labels 映射）与本地 StructureBucket。 */
  buckets: Array<{ key: string; label?: string; count: number | null; suppressed: boolean }>;
  labels?: Record<string, string>;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.count ?? 0));
  return (
    <div className="admin-structure-group admin-section">
      <p className="admin-muted">{title}</p>
      {buckets.length === 0 ? <p className="admin-muted">暂无数据</p> : null}
      <div className="admin-structure-bars">
        {buckets.map((bucket) => (
          <div key={bucket.key} className="admin-structure-bar">
            <span style={{ minWidth: 96 }}>{labels?.[bucket.key] ?? bucket.label ?? bucket.key}</span>
            {bucket.suppressed ? (
              <span className="admin-muted">样本不足</span>
            ) : (
              <>
                <div
                  className="admin-structure-bar-fill"
                  style={{ width: `${Math.max(2, ((bucket.count ?? 0) / max) * 120)}px` }}
                />
                <span>{bucket.count}</span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 配对管理（T4 管理员配对界面）：等待/已配对队列视图 + 手工调整。
 * 队列由集合 API 读取（机构隔离由 rules 强制），姓名取本场报名的 FULL_NAME 标准字段；
 * 手工调整走 T2 reassign 端点（原子释放涉及的 active pair 并新建一组，原因必填、写审计）。
 */
function PairingManager({
  activity,
  refreshKey,
}: {
  activity: ActivityRecord;
  refreshKey: string;
}) {
  const [checkins, setCheckins] = useState<CheckinRecord[] | null>(null);
  const [pairs, setPairs] = useState<ActivityPairRecord[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState('');
  const [speakerId, setSpeakerId] = useState('');
  const [listenerId, setListenerId] = useState('');
  const [reassignOpen, setReassignOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    setError('');
    (async () => {
      try {
        const cc = adminCollections();
        const [checkinList, pairList, fullNameDefs] = await Promise.all([
          cc.checkins.getFullList({
            filter: `activity_id = "${activity.id}" && status = "valid" && onsite_sequence > 0`,
            sort: 'onsite_sequence',
          }),
          cc.activityPairs.getFullList({
            filter: `activity_id = "${activity.id}" && status = "active"`,
            sort: 'pair_sequence',
          }),
          cc.registrationFieldDefs.getFullList({
            filter: 'field_code = "FULL_NAME" && status = "active"',
            fields: 'id',
          }),
        ]);
        let nameMap = new Map<string, string>();
        const fullNameDef = fullNameDefs[0];
        if (fullNameDef) {
          const answers = await cc.registrationAnswers.getFullList({
            filter: `field_def_id = "${fullNameDef.id}" && registration_id.activity_id = "${activity.id}"`,
            fields: 'registration_id,value_json',
          });
          if (cancelled) return;
          nameMap = new Map(
            answers.map((a) => [
              a.registration_id,
              typeof a.value_json === 'string' ? a.value_json : String(a.value_json ?? ''),
            ]),
          );
        }
        if (cancelled) return;
        setCheckins(checkinList);
        setPairs(pairList);
        setNames(nameMap);
      } catch (err) {
        if (!cancelled) setError(normalizeApiError(err).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activity.id, refreshKey]);

  const pairedCheckinIds = useMemo(() => {
    const set = new Set<string>();
    for (const pair of pairs) {
      set.add(pair.speaker_checkin_id);
      set.add(pair.listener_checkin_id);
    }
    return set;
  }, [pairs]);

  const nameOf = (checkin: CheckinRecord) =>
    names.get(checkin.registration_id) || shortId(checkin.participant_id);

  const waitingSpeakers = (checkins ?? []).filter(
    (c) => c.onsite_role === 'speaker' && !pairedCheckinIds.has(c.id),
  );
  const waitingListeners = (checkins ?? []).filter(
    (c) => c.onsite_role === 'listener' && !pairedCheckinIds.has(c.id),
  );

  const submitReassign = async (reason: string) => {
    if (!speakerId || !listenerId) {
      setActionError('请选择要组成新组的倾诉者与聆听者');
      throw new Error('missing pairing members');
    }
    setBusy(true);
    setActionError('');
    setNote('');
    try {
      const res = await reassignActivityPairing(activity.id, {
        speaker_checkin_id: speakerId,
        listener_checkin_id: listenerId,
        reason,
      });
      setReassignOpen(false);
      setSpeakerId('');
      setListenerId('');
      setNote(
        `已调整：新组 P${String(res.pairing.pair_sequence).padStart(2, '0')}` +
          (res.released_pair_ids.length > 0 ? `，释放原 ${res.released_pair_ids.length} 组` : ''),
      );
    } catch (err) {
      setActionError(normalizeApiError(err).message);
      throw err;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="配对管理" className="admin-section">
      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
      {checkins === null && !error ? <Loading label="配对队列加载中…" /> : null}
      {checkins !== null ? (
        <>
          <div className="admin-form-grid">
            <div>
              <h3>等待中的倾诉者（{waitingSpeakers.length}）</h3>
              {waitingSpeakers.length === 0 ? <p className="admin-muted">无</p> : null}
              <ul className="admin-note-list">
                {waitingSpeakers.map((c) => (
                  <li key={c.id}>
                    <code>{onsiteCodeOf(c)}</code> {nameOf(c)}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>等待中的聆听者（{waitingListeners.length}）</h3>
              {waitingListeners.length === 0 ? <p className="admin-muted">无</p> : null}
              <ul className="admin-note-list">
                {waitingListeners.map((c) => (
                  <li key={c.id}>
                    <code>{onsiteCodeOf(c)}</code> {nameOf(c)}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <h3 className="admin-section">已配对（{pairs.length} 组）</h3>
          {pairs.length === 0 ? (
            <p className="admin-muted">尚无配对；确认现场基本到齐后点击「开始配对」（幂等，重复点击结果一致）。</p>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>组号</th>
                    <th>倾诉者</th>
                    <th>聆听者</th>
                    <th>配对时间</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((pair) => {
                    const speaker = (checkins ?? []).find((c) => c.id === pair.speaker_checkin_id);
                    const listener = (checkins ?? []).find((c) => c.id === pair.listener_checkin_id);
                    return (
                      <tr key={pair.id}>
                        <td>
                          <code>P{String(pair.pair_sequence).padStart(2, '0')}</code>
                        </td>
                        <td>
                          {speaker ? (
                            <>
                              <code>{onsiteCodeOf(speaker)}</code> {nameOf(speaker)}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          {listener ? (
                            <>
                              <code>{onsiteCodeOf(listener)}</code> {nameOf(listener)}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{formatDateTime(pair.paired_at)}</td>
                        <td className="admin-muted">{pair.adjustment_reason ? `调整：${pair.adjustment_reason}` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="admin-row-actions admin-section">
            <Button
              variant="secondary"
              onClick={() => {
                setActionError('');
                setReassignOpen(true);
              }}
            >
              手工调整配对
            </Button>
          </div>
          {note ? <p className="cc-hint admin-section">{note}</p> : null}
        </>
      ) : null}

      <ReasonModal
        open={reassignOpen}
        title="手工调整配对"
        confirmLabel="确认调整"
        reasonRequired
        reasonLabel="调整原因"
        submitting={busy}
        onClose={() => setReassignOpen(false)}
        onSubmit={submitReassign}
      >
        <p className="admin-muted">
          选择一位已签到的倾诉者与一位已签到的聆听者组成新组；两人若已有配对将被原子释放
          （同一参与者同一时刻至多一个有效配对），原因必填并写入审计（专项 PRD §5.2）。
        </p>
        <div className="cc-field">
          <label className="cc-label" htmlFor="reassign-speaker">
            倾诉者
            <span className="cc-required" aria-hidden="true">
              *
            </span>
          </label>
          <select
            id="reassign-speaker"
            className="admin-select"
            value={speakerId}
            onChange={(e) => setSpeakerId(e.target.value)}
          >
            <option value="">请选择已签到倾诉者</option>
            {(checkins ?? [])
              .filter((c) => c.onsite_role === 'speaker')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {onsiteCodeOf(c)} {nameOf(c)}
                </option>
              ))}
          </select>
        </div>
        <div className="cc-field">
          <label className="cc-label" htmlFor="reassign-listener">
            聆听者
            <span className="cc-required" aria-hidden="true">
              *
            </span>
          </label>
          <select
            id="reassign-listener"
            className="admin-select"
            value={listenerId}
            onChange={(e) => setListenerId(e.target.value)}
          >
            <option value="">请选择已签到聆听者</option>
            {(checkins ?? [])
              .filter((c) => c.onsite_role === 'listener')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {onsiteCodeOf(c)} {nameOf(c)}
                </option>
              ))}
          </select>
        </div>
        {actionError ? (
          <p className="cc-error" role="alert">
            {actionError}
          </p>
        ) : null}
      </ReasonModal>
    </Card>
  );
}
