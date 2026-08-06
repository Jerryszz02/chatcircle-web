import type {
  ActivityRole,
  ExportScope,
  RegistrationStatus,
  RoleScope,
} from '../../../shared/api/types';
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

/** 从模板复制创建活动问卷（FR-SUR-011：取模板当前版本物化题目）。 */
export function createActivitySurvey(
  activityId: string,
  input: { template_version_id: string; title: string; role_scope: RoleScope },
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

/** 看板筛选项（与约定 query 参数一致；organization_id 由服务端按身份注入，前端不传）。 */
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
