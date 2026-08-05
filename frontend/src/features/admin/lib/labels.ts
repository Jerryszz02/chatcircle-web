import type {
  ActivityRole,
  ActivityStatus,
  AuditActorRole,
  AuditResult,
  CheckinSource,
  CheckinStatus,
  ExportStatus,
  FieldType,
  QuestionType,
  RegistrationStatus,
  RoleScope,
  SourceType,
  SubmissionStatus,
  SurveyStatus,
} from '../../../shared/api/types';

/**
 * 枚举机器码 → 中文标签（机器码定义见 shared/api/types 与 database-design §5.5）。
 * 仅机构管理端展示使用；新增枚举值时在此补标签，缺失时回退显示原值。
 */

export const ACTIVITY_STATUS_LABELS: Record<ActivityStatus, string> = {
  draft: '草稿',
  pending_review: '待平台审核',
  rejected: '已驳回',
  published: '已发布',
  closed: '已关闭',
  taken_down: '已下架',
  archived: '已归档',
};

export const REGISTRATION_STATUS_LABELS: Record<RegistrationStatus, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
  cancelled: '已取消',
};

export const ACTIVITY_ROLE_LABELS: Record<ActivityRole, string> = {
  speaker: '倾诉者',
  listener: '聆听者',
};

export const CHECKIN_SESSION_OPEN_LABEL = '已开放';
export const CHECKIN_SESSION_CLOSED_LABEL = '未开放';

export const CHECKIN_STATUS_LABELS: Record<CheckinStatus, string> = {
  valid: '已签到',
  revoked: '已撤销',
};

export const CHECKIN_SOURCE_LABELS: Record<CheckinSource, string> = {
  self_scan: '自助扫码',
  manual: '管理员补签',
};

export const SURVEY_STATUS_LABELS: Record<SurveyStatus, string> = {
  draft: '草稿',
  not_open: '未开放',
  open: '开放中',
  ended: '已结束',
  archived: '已归档',
};

export const ROLE_SCOPE_LABELS: Record<RoleScope, string> = {
  speaker: '仅倾诉者',
  listener: '仅聆听者',
  both: '倾诉者与聆听者',
};

export const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  draft: '草稿',
  submitted: '已提交',
  voided: '已作废',
};

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: '单行文本',
  number: '数字',
  single_choice: '单选',
  multi_choice: '多选',
  date: '日期',
};

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  info: '说明',
  single_choice: '单选',
  multi_choice: '多选',
  scale_1_5: '1-5 量表',
  scale_0_10: '0-10 量表',
  text_short: '单行文本',
  text_long: '多行文本',
};

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  standard: '标准',
  custom: '自定义',
};

export const EXPORT_STATUS_LABELS: Record<ExportStatus, string> = {
  running: '生成中',
  done: '已完成',
  failed: '失败',
};

export const AUDIT_RESULT_LABELS: Record<AuditResult, string> = {
  success: '成功',
  failure: '失败',
};

export const AUDIT_ACTOR_ROLE_LABELS: Record<AuditActorRole, string> = {
  super_admin: '超级管理员',
  admin: '机构管理员',
  participant: '参与者',
  system: '系统',
};
