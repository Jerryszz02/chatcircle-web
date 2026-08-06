import { ApiError, apiGet, apiPost } from '../../shared/api/http';
import type {
  AdminInviteRecord,
  ExportJobRecord,
  ExportScope,
} from '../../shared/api/types';
import type { MetricData } from '../../shared/metrics/MetricRenderer';
import type { MetricKey } from '../../shared/metrics/registry';
import { PB_URL, pbForRole } from '../../shared/pocketbase';
import { normalizeBackupStatus, type BackupStatus } from './lib/backup';

/**
 * 超级管理端自定义端点封装（统一端点契约，见 technical-design §5.5/§5.6/§5.8）。
 * 全部端点使用 super 角色 client（_superusers 会话），路径/方法/参数不得改名。
 * 集合级 CRUD（机构、邀请码列表、活动列表、模板、审计检索等）直接走
 * shared/api/collections 的类型化封装，不在此重复包装。
 */

function superClient() {
  return pbForRole('super');
}

// ---------- 邀请码（FR-ORG-002） ----------

/** 生成邀请码的响应（已核对后端 super.pb.js 实际形态：{ invite: { id, organization_id,
 *  token, status, expires_at } }，明文 token 仅此一次返回，不落库、列表不可再查，PRD §11.2）。 */
export interface CreateInviteResponse {
  invite: {
    id: string;
    organization_id: string;
    /** 邀请码明文（仅此一次展示）。 */
    token: string;
    status: AdminInviteRecord['status'];
    expires_at: string;
  };
}

/** 从响应中提取明文邀请码（已核对后端形态为 invite.token；兼容顶层 code/token 等历史命名）。 */
export function extractInviteCode(res: unknown): string {
  if (typeof res !== 'object' || res === null) return '';
  const obj = res as Record<string, unknown>;
  const invite = obj.invite as Record<string, unknown> | undefined;
  if (invite && typeof invite.token === 'string' && invite.token !== '') return invite.token;
  for (const key of ['invite_code', 'code', 'token', 'plaintext'] as const) {
    const v = obj[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}

/** 生成一次性邀请码；expires_in_days 默认 7 天、可调整（PRD §4.2）。 */
export function createInvite(input: {
  organization_id: string;
  expires_in_days?: number;
}): Promise<CreateInviteResponse> {
  return apiPost<CreateInviteResponse>(superClient(), '/api/cc/super/invites', input);
}

/** 撤销邀请码（仅未使用且未过期可撤，写审计）。 */
export function revokeInvite(inviteId: string): Promise<unknown> {
  return apiPost(superClient(), `/api/cc/super/invites/${inviteId}/revoke`, {});
}

// ---------- 活动审批 / 下架（PRD §4.3，仅超管） ----------

/** 批准发布：pending_review → published（写 activity_approvals + 审计）。 */
export function approveActivity(activityId: string): Promise<unknown> {
  return apiPost(superClient(), `/api/cc/activities/${activityId}/approve`, {});
}

/** 驳回发布：pending_review → rejected，原因必填（机构可见并修改重提）。 */
export function rejectActivity(activityId: string, reason: string): Promise<unknown> {
  return apiPost(superClient(), `/api/cc/activities/${activityId}/reject`, { reason });
}

/** 下架：published → taken_down（公开入口不可访问、历史保留，写审计）。 */
export function unpublishActivity(activityId: string): Promise<unknown> {
  return apiPost(superClient(), `/api/cc/activities/${activityId}/unpublish`, {});
}

// ---------- 全局看板（technical-design §5.6、FR-DASH-001~004） ----------

/** 看板筛选参数；空值不下发，机构范围由服务端按身份注入/校验。 */
export interface MetricFilters {
  from?: string;
  to?: string;
  organization_id?: string;
  activity_status?: string;
  activity_role?: string;
}

/**
 * 拉取单个指标：GET /api/cc/metrics/:metric_key?from&to&organization_id&activity_status&activity_role。
 * 已核对后端 metrics.pb.js 实际形态：{ metric_key, value, numerator?, denominator?, note?,
 * filters, activity_count }，顶层 value 恒为数值；比率指标 value 为 0~1 小数，
 * 此处转百分比展示（与 admin 端 normalizeMetricValue 口径一致）。
 */
export async function fetchMetric(
  metricKey: MetricKey,
  filters: MetricFilters,
): Promise<MetricData> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  const raw = await apiGet<{ value?: unknown }>(
    superClient(),
    `/api/cc/metrics/${metricKey}${qs ? `?${qs}` : ''}`,
  );
  const num = raw && typeof raw.value === 'number' ? raw.value : undefined;
  if (metricKey === 'survey_completion_rate' && num !== undefined) {
    const percent = num <= 1 ? num * 100 : num;
    return { value: `${Math.round(percent * 10) / 10}%` };
  }
  return { value: num ?? '—' };
}

// ---------- 全局导出（FR-EXP-001~006） ----------

/** 创建导出任务的响应（已核对后端 exports.pb.js 实际形态：同步生成 ZIP 后返回任务摘要）。 */
export interface CreateExportJobResponse {
  export_job: {
    id: string;
    status: ExportJobRecord['status'];
    scope: ExportScope;
    include_pii: boolean;
    file_checksum?: string;
    created?: string;
  };
}

/** 创建导出任务；敏感导出需 include_pii=true 且 confirm=true（二次确认，AC-17）。 */
export function createExportJob(input: {
  scope: ExportScope;
  include_pii: boolean;
}): Promise<CreateExportJobResponse> {
  return apiPost<CreateExportJobResponse>(superClient(), '/api/cc/exports', {
    scope: input.scope,
    include_pii: input.include_pii,
    confirm: true,
  });
}

/** 从创建响应中提取导出任务 id（兼容 { export_job } 包裹与裸 record 两种形态）。 */
export function extractExportJobId(res: unknown): string | null {
  if (typeof res !== 'object' || res === null) return null;
  const obj = res as Record<string, unknown>;
  const wrapped = obj.export_job as Record<string, unknown> | undefined;
  if (wrapped && typeof wrapped.id === 'string') return wrapped.id;
  if (typeof obj.id === 'string') return obj.id;
  return null;
}

/**
 * 鉴权下载导出 ZIP（GET /api/cc/exports/:id/download）。
 * 文件在受保护目录、URL 不可猜（FR-EXP-005），必须携带超管 token；
 * 走原生 fetch 以二进制接收，再触发浏览器保存。
 */
export async function downloadExportFile(job: Pick<ExportJobRecord, 'id'>): Promise<void> {
  const token = superClient().authStore.token;
  const res = await fetch(`${PB_URL}/api/cc/exports/${job.id}/download`, {
    headers: token ? { Authorization: token } : {},
  });
  if (!res.ok) {
    let message = '下载失败，请稍后重试';
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // 非 JSON 错误体，使用默认文案
    }
    throw new ApiError(message, res.status, 'HTTP_ERROR');
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const filename = match ? decodeURIComponent(match[1].replace(/"$/, '')) : `export-${job.id}.zip`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// ---------- 问卷模板（FR-SUR-001/011、PRD §11.3 模板发布审计） ----------

/** 新建模板的响应（已核对后端 super.pb.js 实际形态：{ template, version }）。 */
export interface CreateTemplateResponse {
  template: {
    id: string;
    template_code: string;
    name: string;
    status: string;
    current_version_id: string;
  };
  version: { id: string; version: number; question_count: number };
}

/**
 * 新建问卷模板 + 首个版本（后端事务：建模板 → 建首版 → 回补 current_version_id，
 * 写审计 template.create）。schema_json 由 TemplateSchemaEditor 产出规范化结构。
 */
export function createSurveyTemplate(input: {
  template_code: string;
  name: string;
  description?: string;
  schema_json: unknown;
}): Promise<CreateTemplateResponse> {
  return apiPost<CreateTemplateResponse>(superClient(), '/api/cc/super/templates', input);
}

/** 发布模板新版本的响应（version = 当前最大版本 + 1）。 */
export interface PublishTemplateVersionResponse {
  template_id: string;
  version: { id: string; version: number; question_count: number };
}

/**
 * 发布模板新版本（后端事务：校验并规范化 schema → 建版本 → 移动 current_version_id，
 * 写审计 template.publish；已发布版本不可变、只影响之后新建问卷，FR-SUR-011）。
 */
export function publishTemplateVersion(
  templateId: string,
  schemaJson: unknown,
): Promise<PublishTemplateVersionResponse> {
  return apiPost<PublishTemplateVersionResponse>(
    superClient(),
    `/api/cc/super/templates/${templateId}/publish`,
    { schema_json: schemaJson },
  );
}

// ---------- 备份（PRD §12.3、AC-23） ----------
/** 读取最近备份状态与失败告警标记。 */
export async function fetchBackupStatus(): Promise<BackupStatus> {
  const raw = await apiGet<unknown>(superClient(), '/api/cc/super/backup-status');
  return normalizeBackupStatus(raw);
}

/** 手动触发一次备份（结果写审计；失败时 backup-status 告警）。 */
export function runBackup(): Promise<unknown> {
  return apiPost(superClient(), '/api/cc/super/backup/run', {});
}
