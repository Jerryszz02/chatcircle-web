import {
  ACCOUNT_EVENT_ENDPOINTS,
  type ActivityLiveSummaryResponse,
  type CreateExportV2Input,
  type CreateExportV2Response,
  type DuplicateActivityResponse,
  type ExportPreviewResponse,
  type ExportSelectionV2,
  type PairingReassignInput,
  type PairingReassignResponse,
  type PairingsStartResponse,
} from '../../../shared/api/accountEvent';
import type { ActivityRole, ExportScope, RegistrationStatus, RoleScope } from '../../../shared/api/types';
import type { MetricKey } from '../../../shared/metrics/registry';
import type { MetricCardData } from '../../../shared/metrics/MetricRenderer';
import { ApiError, apiGet, apiPost } from '../../../shared/api/http';
import { collectionsForRole } from '../../../shared/api/collections';
import { adminAuth } from '../../../shared/auth';
import { PB_URL } from '../../../shared/pocketbase';
import type { AdminActivityAction, AdminSurveyAction } from './rules';

/**
 * 机构管理端自定义端点封装（统一端点契约，technical-design §5.5）。
 *
 * 全部经 adminAuth 的 PocketBase client 发送（自动携带 admin 会话 token）；
 * 机构范围由服务端按登录身份注入，客户端不传 organization_id（FR-ORG-006、§12.2）。
 * 幂等由服务端唯一约束与「已存在则返回现状」语义兜底（AC-20），前端不自动重试。
 */

function adminClient() {
  return adminAuth.client;
}

/** T3 单活动实时工作台快照；Realtime 只负责失效化，所有指标均以本响应为准。 */
export function fetchActivityLiveSummary(
  activityId: string,
): Promise<ActivityLiveSummaryResponse> {
  return apiGet(adminClient(), ACCOUNT_EVENT_ENDPOINTS.activityLiveSummary(activityId));
}

/** 报名状态迁移：审核通过/拒绝/取消/回退（回退与取消 reason 必填）；审核时可同时改角色。 */
export function transitionRegistration(
  id: string,
  input: { to: RegistrationStatus; reason?: string; activity_role?: ActivityRole },
): Promise<unknown> {
  return apiPost(adminClient(), `/api/cc/registrations/${id}/transition`, input);
}

/** 活动生命周期动作：submit-review / publish / close / archive。 */
export function runActivityAction(id: string, action: AdminActivityAction): Promise<unknown> {
  return apiPost(adminClient(), `/api/cc/activities/${id}/${action}`);
}

/**
 * 复制活动（PRD §4.1）：服务端重新生成活动代码、签到 token 与问卷入口 token，
 * 不复制历史报名/签到/配对/答卷/审计；新活动恒为 draft。
 */
export function duplicateActivity(activityId: string, asTemplate = false): Promise<DuplicateActivityResponse> {
  return apiPost(adminClient(), ACCOUNT_EVENT_ENDPOINTS.duplicateActivity(activityId), { as_template: asTemplate });
}

/** 开始配对（幂等，重复调用只补齐等待队列，不重排旧组，api-design §4.1）。 */
export function startActivityPairings(activityId: string): Promise<PairingsStartResponse> {
  return apiPost(adminClient(), ACCOUNT_EVENT_ENDPOINTS.startPairings(activityId));
}

/** 手工调整配对（reason 必填，原子释放涉及的 active pair 并新建一组）。 */
export function reassignActivityPairing(
  activityId: string,
  input: PairingReassignInput,
): Promise<PairingReassignResponse> {
  return apiPost(adminClient(), ACCOUNT_EVENT_ENDPOINTS.reassignPairing(activityId), input);
}

/** 开放签到（FR-CHK-002；可重复开放/关闭）。 */
export function openCheckin(activityId: string): Promise<unknown> {
  return apiPost(adminClient(), `/api/cc/activities/${activityId}/checkin/open`);
}

/** 关闭签到。 */
export function closeCheckin(activityId: string): Promise<unknown> {
  return apiPost(adminClient(), `/api/cc/activities/${activityId}/checkin/close`);
}

/** 管理员补签（FR-CHK-005：reason 必填，写审计）。 */
export function manualCheckin(input: {
  activity_id: string;
  participant_id: string;
  reason: string;
}): Promise<unknown> {
  return apiPost(adminClient(), '/api/cc/checkins/manual', input);
}

/** 补签候选人（已通过报名者，含用户名；管理员不可读参与者集合，由服务端按本机构活动注入）。 */
export interface ManualCheckinCandidate {
  participant_id: string;
  username: string;
  activity_role: ActivityRole;
}

export async function fetchManualCheckinCandidates(
  activityId: string,
): Promise<ManualCheckinCandidate[]> {
  const res = await apiGet(adminClient(), `/api/cc/activities/${activityId}/checkin/manual-candidates`);
  return ((res as { candidates?: ManualCheckinCandidate[] }).candidates ?? []) as ManualCheckinCandidate[];
}

/** 撤销签到（reason 必填，保留原记录，写审计）。 */
export function revokeCheckin(id: string, reason: string): Promise<unknown> {
  return apiPost(adminClient(), `/api/cc/checkins/${id}/revoke`, { reason });
}

/** 培训生命周期动作：publish（草稿→已发布）/ close（已发布→已关闭），机构管理员 + 审计。 */
export type AdminTrainingAction = 'publish' | 'close';

export function runTrainingAction(id: string, action: AdminTrainingAction): Promise<unknown> {
  return apiPost(adminClient(), `/api/cc/trainings/${id}/${action}`);
}

/** 开放培训签到（同活动签到：可重复开放/关闭，同培训至多一条 open 会话）。 */
export function openTrainingCheckin(trainingId: string): Promise<unknown> {
  return apiPost(adminClient(), `/api/cc/trainings/${trainingId}/checkin/open`);
}

/** 关闭培训签到。 */
export function closeTrainingCheckin(trainingId: string): Promise<unknown> {
  return apiPost(adminClient(), `/api/cc/trainings/${trainingId}/checkin/close`);
}

/** 培训管理员补签（reason 必填，写审计；participant_id/username 二选一，照搬活动补签形态）。 */
export function manualTrainingCheckin(input: {
  training_id: string;
  participant_id?: string;
  username?: string;
  reason: string;
}): Promise<unknown> {
  return apiPost(adminClient(), '/api/cc/training-checkins/manual', input);
}

/** 培训补签候选人（含用户名；管理员不可读参与者集合，由服务端注入）。 */
export interface ManualTrainingCheckinCandidate {
  participant_id: string;
  username: string;
}

export async function fetchManualTrainingCheckinCandidates(
  trainingId: string,
): Promise<ManualTrainingCheckinCandidate[]> {
  const res = await apiGet(
    adminClient(),
    `/api/cc/trainings/${trainingId}/checkin/manual-candidates`,
  );
  return ((res as { candidates?: ManualTrainingCheckinCandidate[] }).candidates ??
    []) as ManualTrainingCheckinCandidate[];
}

/** 撤销培训签到（reason 必填，保留原记录，写审计）。 */
export function revokeTrainingCheckin(id: string, reason: string): Promise<unknown> {
  return apiPost(adminClient(), `/api/cc/training-checkins/${id}/revoke`, { reason });
}

/** 从模板复制创建活动问卷（FR-SUR-011：取模板当前版本物化题目）。 */
export function createActivitySurvey(
  activityId: string,
  input: { template_version_id: string; title: string; role_scope: RoleScope; phase?: 'before' | 'onsite' | 'after'; planned_open_at?: string },
): Promise<unknown> {
  return apiPost(adminClient(), `/api/cc/activities/${activityId}/surveys`, input);
}

/** 问卷开放/结束（手动控制，不被签到或时间点强制，PRD §8.2）。 */
export function runSurveyAction(id: string, action: AdminSurveyAction): Promise<unknown> {
  return apiPost(adminClient(), `/api/cc/activity-surveys/${id}/${action}`);
}

/** 答卷作废（FR-SUR-010：reason 必填，原记录保留 + 审计，统计与导出排除）。 */
export function voidSubmission(id: string, reason: string): Promise<unknown> {
  return apiPost(adminClient(), `/api/cc/submissions/${id}/void`, { reason });
}

/**
 * 创建导出任务（FR-EXP-001~005）：
 * - 管理员范围仅允许本机构全部或本机构单活动（服务端校验 FR-EXP-004）；
 * - 敏感导出需机构开关 + 二次确认（confirm:true）+ 审计（FR-EXP-003、AC-17）；
 * - 服务端同步生成 ZIP 并写 export_jobs。
 */
export function createExport(input: {
  scope: ExportScope;
  include_pii: boolean;
  confirm: true;
}): Promise<unknown> {
  return apiPost(adminClient(), '/api/cc/exports', input);
}

/**
 * T6 细粒度导出预览（PRD §7 / api-design §6）：先预览后生成。
 * 返回归一化 selection、分数据域预估行数、服务端判敏结果与权限检查；
 * 不落库、不返回实际数据值。
 */
export function previewExportV2(input: ExportSelectionV2): Promise<ExportPreviewResponse> {
  return apiPost(adminClient(), ACCOUNT_EVENT_ENDPOINTS.exportPreview, input);
}

/**
 * T6 细粒度导出创建：敏感导出须 confirm_sensitive:true（服务端仍重算判敏，
 * 前端布尔值不作数）；成功返回 export_job_id，文件经既有鉴权下载端点获取。
 */
export function createExportV2(input: CreateExportV2Input): Promise<CreateExportV2Response> {
  return apiPost(adminClient(), ACCOUNT_EVENT_ENDPOINTS.createExport, input);
}

/** 看板筛选项（与约定 query 参数一致；organization_id 由服务端按身份注入，前端不传）。
 *  from/to 接受纯日期 YYYY-MM-DD（UTC 日边界）或完整 PB datetime（精确边界，from 含 to 不含）；
 *  页面侧统一经 localDayToPbUtcRange 换算后下发，与活动明细下钻同口径。 */
export interface MetricFilters {
  from?: string;
  to?: string;
  activity_status?: string;
  activity_role?: ActivityRole;
}

/** 聚合端点原始响应（已核对后端 metrics.pb.js 实际形态 { metric_key, value, ... }，
 *  顶层 value 恒为数值；normalizeMetricValue 仍保留防御兼容 count/ratio/裸数字）。 */
export interface MetricResponse {
  value?: number;
  count?: number;
  ratio?: number;
  [key: string]: unknown;
}

/** 拉取单项指标：GET /api/cc/metrics/:metric_key?from&to&activity_status&activity_role。 */
export function fetchMetric(key: MetricKey, filters: MetricFilters): Promise<MetricResponse> {
  return apiGet(adminClient(), `/api/cc/metrics/${key}`, {
    query: Object.fromEntries(
      Object.entries({
        from: filters.from,
        to: filters.to,
        activity_status: filters.activity_status,
        activity_role: filters.activity_role,
      }).filter(([, v]) => v !== undefined && v !== ''),
    ),
  });
}

/**
 * 把聚合端点响应规范化为指标卡数据（防御式：兼容 value/count/ratio 与裸数字；
 * ratio 口径按百分比展示）。后端最终响应形态确定后可收窄本函数。
 */
export function normalizeMetricValue(
  key: MetricKey,
  raw: MetricResponse | number | null | undefined,
): MetricCardData {
  let num: number | undefined;
  if (typeof raw === 'number') {
    num = raw;
  } else if (raw && typeof raw === 'object') {
    const candidate = raw.value ?? raw.count ?? raw.ratio;
    if (typeof candidate === 'number') num = candidate;
  }
  if (num === undefined || Number.isNaN(num)) return { value: '—' };
  if (key === 'survey_completion_rate') {
    const percent = num <= 1 ? num * 100 : num;
    return { value: `${Math.round(percent * 10) / 10}%` };
  }
  return { value: num };
}

/** 鉴权下载导出文件（FR-EXP-005：仅鉴权后台可下载，URL 不可猜）。 */
export async function downloadExport(jobId: string, filename: string): Promise<void> {
  const res = await fetch(`${PB_URL}/api/cc/exports/${jobId}/download`, {
    headers: { Authorization: adminAuth.token },
  });
  if (!res.ok) {
    let message = '下载失败，请稍后重试';
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // 响应非 JSON 时使用默认文案
    }
    throw new ApiError(message, res.status, 'HTTP_ERROR');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 类型化集合入口（admin 会话；机构隔离由服务端 API rules 强制）。 */
export function adminCollections() {
  return collectionsForRole('admin');
}
