import type {
  ActivityLiveSummaryResponse,
  CompletionMetric,
} from '../../../shared/api/accountEvent';
import type {
  ActivityRecord,
  RegistrationStatus,
} from '../../../shared/api/types';
import { parsePbDate } from '../../../shared/lib/datetime';
import { formatDateTime, fromInputDateTime } from './format';
import { validateCapacityEdit } from './rules';

/**
 * T4 机构活动工作台纯函数（PRD §4.1~§4.3）。
 *
 * - 生命周期阶段推导（招募中/活动前/现场中/活动后）只是体验层路由提示，
 *   业务事实以后端 hooks 与 live-summary 快照为准；
 * - 参与者结构聚合的「小样本抑制」口径与 T3 服务端一致：任一分组人数 < 5 时
 *   该维度全部分组合并抑制为「样本不足」，防止结合总数做减法反推（PRD §4.3）；
 * - 完成率展示口径：分母为 0 显示「—」，比例强制夹在 [0,100%]。
 */

// ---------- 生命周期阶段（PRD §4.2） ----------

export type ActivityLifecycleStage = 'setup' | 'recruiting' | 'pre_event' | 'onsite' | 'post_event';

export const LIFECYCLE_STAGE_LABELS: Record<ActivityLifecycleStage, string> = {
  setup: '筹备中',
  recruiting: '招募中',
  pre_event: '活动前',
  onsite: '现场中',
  post_event: '活动后',
};

/** 阶段推导所需的活动字段子集。 */
export type LifecycleActivity = Pick<
  ActivityRecord,
  | 'status'
  | 'start_time'
  | 'end_time'
  | 'registration_open'
  | 'registration_start_at'
  | 'registration_end_at'
  | 'capacity_total'
  | 'pairing_started_at'
  | 'onsite_locked_at'
>;

/**
 * 活动生命周期阶段（体验层推导，PRD §4.2）：
 * - setup：草稿/待审核/已驳回（尚未发布）；
 * - post_event：已关闭/已下架/已归档，或已发布但结束时间已过；
 * - onsite：已发布且（配对已开始 / 现场已锁定 / 当前处于活动起止时间内）；
 * - recruiting：已发布、活动未开始且报名仍在接受（开关开 + 窗口内 + 名额未满）；
 * - pre_event：已发布、活动未开始但报名已不再接受。
 */
export function deriveActivityStage(
  activity: LifecycleActivity,
  now: Date,
  approvedTotal: number,
): ActivityLifecycleStage {
  const status = activity.status;
  if (status === 'draft' || status === 'pending_review' || status === 'rejected') return 'setup';
  if (status === 'closed' || status === 'taken_down' || status === 'archived') return 'post_event';
  // published
  if (activity.pairing_started_at || activity.onsite_locked_at) return 'onsite';
  const start = parsePbDate(activity.start_time);
  const end = parsePbDate(activity.end_time);
  if (start && end && now >= start && now <= end) return 'onsite';
  if (end && now > end) return 'post_event';
  const regStart = parsePbDate(activity.registration_start_at);
  const regEnd = parsePbDate(activity.registration_end_at);
  const withinWindow = (!regStart || now >= regStart) && (!regEnd || now <= regEnd);
  const accepting =
    activity.registration_open && withinWindow && approvedTotal < activity.capacity_total;
  return accepting ? 'recruiting' : 'pre_event';
}

// ---------- 比率与完成率展示（PRD §4.3 口径：分母 0 →「—」，不超过 100%） ----------

export function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '—';
  const clamped = Math.max(0, Math.min(1, rate));
  return `${Math.round(clamped * 1000) / 10}%`;
}

/** 问卷完成率卡片行：「已提交/符合资格 + 比率」，分母为 0 时比率显示「—」。 */
export function formatCompletion(metric: CompletionMetric): string {
  return `${metric.submitted}/${metric.eligible}（${formatPercent(metric.rate)}）`;
}

// ---------- 报名趋势（招募中，PRD §4.2） ----------

export interface TrendPoint {
  /** 本地日期 YYYY-MM-DD。 */
  date: string;
  /** 短标签 M/D。 */
  label: string;
  count: number;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 最近 days 天（含今天）的报名提交计数，无提交的日期补 0，按本地自然日分组。 */
export function buildRegistrationTrend(
  registrations: Array<Pick<RegistrationLike, 'submitted_at'>>,
  days = 14,
  now: Date = new Date(),
): TrendPoint[] {
  const counts = new Map<string, number>();
  for (const reg of registrations) {
    const d = parsePbDate(reg.submitted_at);
    if (!d) continue;
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const points: TrendPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${day.getFullYear()}-${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}`;
    points.push({ date: key, label: `${day.getMonth() + 1}/${day.getDate()}`, count: counts.get(key) ?? 0 });
  }
  return points;
}

// ---------- 参与者结构聚合（PRD §4.3：任一分组 <5 则同维度全部抑制） ----------

export const STRUCTURE_SUPPRESSION_THRESHOLD = 5;

export interface StructureBucket {
  key: string;
  label: string;
  /** suppressed 时恒为 null。 */
  count: number | null;
  suppressed: boolean;
}

/**
 * 小样本联合抑制：任一非零分组人数 < threshold 时，该维度全部分组的计数都置 null
 * 并标记 suppressed（只保留分桶标签）。计数为 0 的分桶不展示（与服务端只输出
 * 观测到的 key 一致，避免「0 人桶」本身泄露信息）。
 */
export function suppressSmallBuckets(
  buckets: Array<{ key: string; label: string; count: number }>,
  threshold: number = STRUCTURE_SUPPRESSION_THRESHOLD,
): StructureBucket[] {
  const observed = buckets.filter((b) => b.count > 0);
  const suppressed = observed.some((b) => b.count < threshold);
  return observed.map((b) => ({
    key: b.key,
    label: b.label,
    count: suppressed ? null : b.count,
    suppressed,
  }));
}

/** 结构聚合所需的最小报名形状。 */
export interface RegistrationLike {
  participant_id: string;
  activity_id: string;
  status: RegistrationStatus;
  submitted_at: string;
}

export interface StructureExtras {
  /** 新参与者/回访参与者（以本机构 approved 报名的最早提交时间判定首次）。 */
  newcomer: StructureBucket[];
  /** 历史参与活动次数分布（含本场，按本机构 approved 报名计数）。 */
  history: StructureBucket[];
  /** 报名提前量：提交时间距活动开始的天数分桶。 */
  leadTime: StructureBucket[];
  /** 参与聚合的本场已通过人数（各维度基数，供界面标注口径）。 */
  baseCount: number;
}

/**
 * 从报名记录聚合新老参与者 / 历史参与次数 / 报名提前量。
 * activityRegistrations 为本场全部报名（取其中 approved），
 * orgApprovedRegistrations 为本机构全部活动的 approved 报名（含本场）。
 */
export function computeStructureExtras(
  activityRegistrations: RegistrationLike[],
  orgApprovedRegistrations: RegistrationLike[],
  activityStart: string,
): StructureExtras {
  const approvedHere = activityRegistrations.filter((r) => r.status === 'approved');
  const historyCountByParticipant = new Map<string, number>();
  const firstApprovedAt = new Map<string, number>();
  for (const reg of orgApprovedRegistrations) {
    historyCountByParticipant.set(
      reg.participant_id,
      (historyCountByParticipant.get(reg.participant_id) ?? 0) + 1,
    );
    const t = parsePbDate(reg.submitted_at)?.getTime();
    if (t === undefined) continue;
    const prev = firstApprovedAt.get(reg.participant_id);
    if (prev === undefined || t < prev) firstApprovedAt.set(reg.participant_id, t);
  }

  let newCount = 0;
  let returningCount = 0;
  const historyCounts = { once: 0, twice: 0, three_plus: 0 };
  const leadCounts = { same_day: 0, d1_3: 0, d4_7: 0, d8_plus: 0 };
  const start = parsePbDate(activityStart)?.getTime();

  for (const reg of approvedHere) {
    const submittedAt = parsePbDate(reg.submitted_at)?.getTime();
    const first = firstApprovedAt.get(reg.participant_id);
    // 本机构最早的 approved 报名不早于本场提交时间 → 新参与者
    if (first === undefined || submittedAt === undefined || first >= submittedAt) {
      newCount += 1;
    } else {
      returningCount += 1;
    }
    const historyCount = historyCountByParticipant.get(reg.participant_id) ?? 1;
    if (historyCount <= 1) historyCounts.once += 1;
    else if (historyCount === 2) historyCounts.twice += 1;
    else historyCounts.three_plus += 1;
    if (start !== undefined && submittedAt !== undefined) {
      const days = Math.max(0, Math.floor((start - submittedAt) / 86400000));
      if (days === 0) leadCounts.same_day += 1;
      else if (days <= 3) leadCounts.d1_3 += 1;
      else if (days <= 7) leadCounts.d4_7 += 1;
      else leadCounts.d8_plus += 1;
    }
  }

  return {
    newcomer: suppressSmallBuckets([
      { key: 'new', label: '新参与者', count: newCount },
      { key: 'returning', label: '回访参与者', count: returningCount },
    ]),
    history: suppressSmallBuckets([
      { key: 'once', label: '第 1 次参加', count: historyCounts.once },
      { key: 'twice', label: '第 2 次参加', count: historyCounts.twice },
      { key: 'three_plus', label: '第 3 次及以上', count: historyCounts.three_plus },
    ]),
    leadTime: suppressSmallBuckets([
      { key: 'same_day', label: '当天报名', count: leadCounts.same_day },
      { key: 'd1_3', label: '提前 1–3 天', count: leadCounts.d1_3 },
      { key: 'd4_7', label: '提前 4–7 天', count: leadCounts.d4_7 },
      { key: 'd8_plus', label: '提前 8 天及以上', count: leadCounts.d8_plus },
    ]),
    baseCount: approvedHere.length,
  };
}

// ---------- 创建向导：基础信息校验与缺失项（PRD §4.1） ----------

export interface WizardBasicsInput {
  title: string;
  activityCode: string;
  startTime: string;
  endTime: string;
  capacityTotal: string;
}

export interface WizardBasicsErrors {
  title?: string;
  activity_code?: string;
  start_time?: string;
  end_time?: string;
  capacity_total?: string;
}

/** 创建向导「基本信息」步校验（规则与 ActivityForm 保持一致）。 */
export function validateWizardBasics(input: WizardBasicsInput): WizardBasicsErrors {
  const errors: WizardBasicsErrors = {};
  if (!input.title.trim()) errors.title = '请输入活动标题';
  if (!input.activityCode.trim()) errors.activity_code = '请输入活动代码（如 CC_SG_202608_01）';
  const start = fromInputDateTime(input.startTime);
  const end = fromInputDateTime(input.endTime);
  if (!start) errors.start_time = '请选择开始时间';
  if (!end) errors.end_time = '请选择结束时间';
  if (start && end && start >= end) errors.end_time = '结束时间须晚于开始时间';
  Object.assign(errors, validateCapacityEdit(Number(input.capacityTotal), ZERO_APPROVED));
  return errors;
}

const ZERO_APPROVED = { total: 0, speaker: 0, listener: 0 };

export interface CompletenessInput {
  title: string;
  activityCode: string;
  description: string;
  location: string;
  /** start/end 均已选择且 start < end。 */
  timeRangeValid: boolean;
  /** 总名额为正偶数。 */
  capacityValid: boolean;
  /** 报名表启用的字段数。 */
  enabledFieldCount: number;
  /** 标准字段「姓名」是否已启用且必填；null 表示平台尚未注册该字段。 */
  fullNameReady: boolean | null;
  /** 向导中勾选创建的问卷数。 */
  surveyCount: number;
}

export interface MissingItem {
  key: string;
  message: string;
}

/** 预览步的缺失项与下一步提示（仅提示不阻断的问题也列出，发布前可回到对应步骤补全）。 */
export function findMissingItems(input: CompletenessInput): MissingItem[] {
  const items: MissingItem[] = [];
  if (!input.title.trim()) items.push({ key: 'title', message: '缺少活动标题（回到「基本信息」）' });
  if (!input.activityCode.trim()) {
    items.push({ key: 'activity_code', message: '缺少活动代码（回到「基本信息」）' });
  }
  if (!input.timeRangeValid) {
    items.push({ key: 'time', message: '活动起止时间未正确设置（回到「基本信息」）' });
  }
  if (!input.capacityValid) {
    items.push({ key: 'capacity', message: '总名额须为正偶数（回到「基本信息」）' });
  }
  if (!input.description.trim()) {
    items.push({ key: 'description', message: '缺少活动介绍，参与者端详情页将没有内容（回到「基本信息」）' });
  }
  if (!input.location.trim()) {
    items.push({ key: 'location', message: '缺少活动地点（回到「基本信息」）' });
  }
  if (input.enabledFieldCount === 0) {
    items.push({ key: 'fields', message: '报名表未启用任何字段（回到「角色与报名」）' });
  }
  if (input.fullNameReady === false) {
    items.push({
      key: 'full_name',
      message: '建议启用并必填标准字段「姓名」，审核与现场找人依赖它（回到「角色与报名」）',
    });
  }
  if (input.surveyCount === 0) {
    items.push({ key: 'surveys', message: '未选择问卷；可在「问卷」步勾选模板，或创建后再添加' });
  }
  return items;
}

// ---------- 通知文案与视图导出（PRD §4.2/§4.3 快捷动作） ----------

/** 微信群通知文案（可复制的模板文本；本期不自动发送，专项 PRD §13 非目标）。 */
export function buildWeComNotice(
  activity: Pick<ActivityRecord, 'title' | 'start_time' | 'end_time' | 'location'>,
  approvedTotal: number,
): string {
  const lines = [
    `【活动通知】${activity.title}`,
    `时间：${formatDateTime(activity.start_time)} 至 ${formatDateTime(activity.end_time)}`,
    activity.location ? `地点：${activity.location}` : '地点：见群内后续通知',
    `当前已通过报名 ${approvedTotal} 人。请按时到场，现场出示签到二维码完成签到。`,
    '如无法到场，请提前联系工作人员取消报名。',
  ];
  return lines.join('\n');
}

/** 问卷催办文案（活动后，按问卷未完成的总体口径生成）。 */
export function buildSurveyReminder(activityTitle: string, surveyTitle: string): string {
  return `【问卷提醒】感谢参加「${activityTitle}」。问卷「${surveyTitle}」尚未收到您的提交，请抽空完成，帮助我们改进活动。`;
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells: Array<string | number>): string {
  return cells.map(csvCell).join(',');
}

/**
 * 「导出当前视图」：把工作台快照序列化为 CSV（UTF-8 BOM，Excel 可直接打开）。
 * 这是现场视图的轻量留档，不是 T6 细粒度导出；正式数据导出仍走 /admin/exports。
 */
export function buildWorkbenchCsv(
  snapshot: ActivityLiveSummaryResponse,
  activity: Pick<ActivityRecord, 'title' | 'activity_code'>,
): string {
  const lines: string[] = [];
  lines.push(csvRow(['Chat Circles 现场工作台快照']));
  lines.push(csvRow(['活动', activity.title]));
  lines.push(csvRow(['活动代码', activity.activity_code]));
  lines.push(csvRow(['快照生成时间', snapshot.generated_at]));
  lines.push('');
  lines.push(csvRow(['报名漏斗', '总数', '倾诉者', '聆听者']));
  const funnel = snapshot.registrations;
  const funnelRows: Array<[string, (typeof funnel)['total']]> = [
    ['报名总数', funnel.total],
    ['待审核', funnel.pending],
    ['已通过', funnel.approved],
    ['已拒绝', funnel.rejected],
    ['已取消', funnel.cancelled],
  ];
  for (const [label, counts] of funnelRows) {
    lines.push(csvRow([label, counts.total, counts.speaker, counts.listener]));
  }
  lines.push('');
  lines.push(csvRow(['签到', '总数', '倾诉者', '聆听者']));
  lines.push(csvRow(['已通过人数', snapshot.checkins.approved.total, snapshot.checkins.approved.speaker, snapshot.checkins.approved.listener]));
  lines.push(csvRow(['有效签到人数', snapshot.checkins.valid.total, snapshot.checkins.valid.speaker, snapshot.checkins.valid.listener]));
  lines.push(csvRow(['签到率', formatPercent(snapshot.checkins.rate.total), formatPercent(snapshot.checkins.rate.speaker), formatPercent(snapshot.checkins.rate.listener)]));
  lines.push('');
  lines.push(csvRow(['配对', '数量']));
  lines.push(csvRow(['已配对组数', snapshot.pairings.active_pairs]));
  lines.push(csvRow(['等待人数（总）', snapshot.pairings.waiting.total]));
  lines.push(csvRow(['等待人数（倾诉者）', snapshot.pairings.waiting.speaker]));
  lines.push(csvRow(['等待人数（聆听者）', snapshot.pairings.waiting.listener]));
  lines.push(csvRow(['未平衡差额', snapshot.pairings.imbalance]));
  lines.push('');
  lines.push(csvRow(['问卷', '现场完成（已提交/符合资格）', '现场完成率', '总体完成（已提交/符合资格）', '总体完成率', '现场未完成人数']));
  for (const survey of snapshot.surveys) {
    lines.push(
      csvRow([
        survey.title,
        `${survey.onsite_completion.submitted}/${survey.onsite_completion.eligible}`,
        formatPercent(survey.onsite_completion.rate),
        `${survey.overall_completion.submitted}/${survey.overall_completion.eligible}`,
        formatPercent(survey.overall_completion.rate),
        Math.max(0, survey.onsite_completion.eligible - survey.onsite_completion.submitted),
      ]),
    );
  }
  lines.push('');
  lines.push(csvRow(['参与者结构', '分组', '人数（分桶不足 5 人时合并为样本不足）']));
  for (const dimension of [
    { label: '性别', buckets: snapshot.demographics.gender },
    { label: '年龄段', buckets: snapshot.demographics.age_range },
  ]) {
    for (const bucket of dimension.buckets) {
      lines.push(csvRow([dimension.label, bucket.key, bucket.suppressed ? '样本不足' : bucket.count ?? '样本不足']));
    }
  }
  return '\uFEFF' + lines.join('\n');
}
