import type {
  ActiveStatus,
  ActivityStatus,
  AuditActorRole,
  AuditResult,
  ExportScope,
  ExportStatus,
  InviteStatus,
  QuestionType,
} from '../../../shared/api/types';

/**
 * 超级管理端状态中文标签（机器码见 shared/api/types，枚举与 database-design §5.5 对齐）。
 * 仅做展示映射，不含任何权限判断——权限由服务端 API rules / hooks 强制。
 */

export const INVITE_STATUS_LABELS: Record<InviteStatus, string> = {
  unused: '未使用',
  used: '已使用',
  revoked: '已撤销',
  expired: '已过期',
};

export const ACTIVITY_STATUS_LABELS: Record<ActivityStatus, string> = {
  draft: '草稿',
  pending_review: '待平台审核',
  rejected: '已驳回',
  published: '已发布',
  closed: '已关闭',
  taken_down: '已下架',
  archived: '已归档',
};

export const ACTIVE_STATUS_LABELS: Record<ActiveStatus, string> = {
  active: '启用',
  disabled: '停用',
};

export const EXPORT_STATUS_LABELS: Record<ExportStatus, string> = {
  running: '生成中',
  done: '已完成',
  failed: '失败',
};

export const AUDIT_ACTOR_ROLE_LABELS: Record<AuditActorRole, string> = {
  super_admin: '超级管理员',
  admin: '机构管理员',
  participant: '参与者',
  system: '系统',
};

export const AUDIT_RESULT_LABELS: Record<AuditResult, string> = {
  success: '成功',
  failure: '失败',
};

/** 导出范围类型（FR-EXP-004：超管可全平台/机构/单活动）。 */
export const EXPORT_SCOPE_TYPE_LABELS: Record<ExportScope['type'], string> = {
  platform: '全平台',
  organization: '机构',
  activity: '单活动',
};

/** 活动内角色标签（看板角色筛选，FR-DASH-004）。 */
export const ACTIVITY_ROLE_LABELS: Record<'speaker' | 'listener', string> = {
  speaker: '倾诉者',
  listener: '聆听者',
};

/** 问卷题型标签（FR-SUR-007 七题型，模板编辑器/版本预览用）。 */
export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  info: '说明',
  single_choice: '单选',
  multi_choice: '多选',
  scale_1_5: '1-5 量表',
  scale_0_10: '0-10 量表',
  text_short: '单行文本',
  text_long: '多行文本',
};
