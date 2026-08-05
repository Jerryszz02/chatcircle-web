/**
 * 集合 record 类型与状态枚举（database-design §5.2 的 19 个集合）。
 *
 * 与 backend/pb_migrations 的 schema 手工保持同步（technical-design §5.2 强制约定；
 * 类型生成工具为「待确认」#17，确认前以手工同步为准）。
 * 枚举机器码为设计草案（database-design D-4）：首个迁移落地后冻结，只增不改。
 */

/** PocketBase 系统公共字段。 */
export interface BaseRecord {
  id: string;
  created: string;
  updated: string;
}

// ---------- 通用枚举（机器码 = database-design §5.5，中文名见注释） ----------

/** 通用启停：active=启用，disabled=停用。 */
export type ActiveStatus = 'active' | 'disabled';
/** 邀请码 4 态：unused=未使用，used=已使用，revoked=已撤销，expired=已过期。 */
export type InviteStatus = 'unused' | 'used' | 'revoked' | 'expired';
/** 活动 7 态（PRD §4.3）。 */
export type ActivityStatus =
  | 'draft' // 草稿
  | 'pending_review' // 待平台审核
  | 'rejected' // 已驳回
  | 'published' // 已发布
  | 'closed' // 已关闭
  | 'taken_down' // 已下架
  | 'archived'; // 已归档
/** 报名 4 态（PRD §4.4，无候补态）。 */
export type RegistrationStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
/** 活动内角色（挂在报名上而非账号上，FR-REG-002）：speaker=倾诉者，listener=聆听者。 */
export type ActivityRole = 'speaker' | 'listener';
/** 签到场次 2 态：open=已开放，closed=已关闭（「未开放」= 无 open 记录）。 */
export type CheckinSessionStatus = 'open' | 'closed';
/** 签到记录 2 态：valid=已签到，revoked=已撤销（「未签到」= 无记录）。 */
export type CheckinStatus = 'valid' | 'revoked';
/** 签到来源：self_scan=自助扫码，manual=管理员补签。 */
export type CheckinSource = 'self_scan' | 'manual';
/** 活动问卷 5 态（PRD §4.5）。 */
export type SurveyStatus = 'draft' | 'not_open' | 'open' | 'ended' | 'archived';
/** 问卷适用角色：both=倾诉者与聆听者均可。 */
export type RoleScope = 'speaker' | 'listener' | 'both';
/** 答卷 3 态（无退回重填，PRD §4.5）。 */
export type SubmissionStatus = 'draft' | 'submitted' | 'voided';
/** 报名字段题型（草案题型集，database-design D-1 确认后定稿）。 */
export type FieldType = 'text' | 'number' | 'single_choice' | 'multi_choice' | 'date';
/** 来源：standard=平台标准，custom=机构自定义。 */
export type SourceType = 'standard' | 'custom';
/** 问卷题型（FR-SUR-007）。 */
export type QuestionType =
  | 'info' // 说明
  | 'single_choice' // 单选
  | 'multi_choice' // 多选
  | 'scale_1_5' // 1-5 量表
  | 'scale_0_10' // 0-10 量表
  | 'text_short' // 单行文本
  | 'text_long'; // 多行文本
/** 导出任务状态。 */
export type ExportStatus = 'running' | 'done' | 'failed';
/** 审计操作者角色。 */
export type AuditActorRole = 'super_admin' | 'admin' | 'participant' | 'system';
/** 审计结果。 */
export type AuditResult = 'success' | 'failure';

// ---------- 5.2.1 organizations — 机构主数据与机构级开关 ----------

export interface OrganizationRecord extends BaseRecord {
  name: string;
  status: ActiveStatus;
  /** 活动发布需平台审核开关（FR-ORG-004）。 */
  require_activity_approval: boolean;
  /** 允许机构管理员敏感导出开关（FR-ORG-005）。 */
  allow_sensitive_export: boolean;
  remark?: string;
}

// ---------- 5.2.2 admin_invites — 一次性管理员邀请码 ----------

export interface AdminInviteRecord extends BaseRecord {
  organization_id: string;
  /** 邀请码哈希；明文只展示一次，不落库（PRD §11.2）。 */
  token_hash: string;
  status: InviteStatus;
  expires_at: string;
  used_by?: string;
  used_at?: string;
  /** 操作者（超级管理员 id）。 */
  created_by: string;
}

// ---------- 5.2.3 admin_accounts — 机构管理员账号（auth） ----------

export interface AdminAccountRecord extends BaseRecord {
  username: string;
  organization_id: string;
  status: ActiveStatus;
  display_name?: string;
}

// ---------- 5.2.4 participant_accounts — 全平台通用参与者账号（auth） ----------

export interface ParticipantAccountRecord extends BaseRecord {
  /** 4–20 位字母/数字/下划线，小写归一化后全局唯一（FR-AUTH-005）。 */
  username: string;
  status: ActiveStatus;
}

// ---------- 5.2.5 activities — 活动主数据与名额 ----------

export interface ActivityRecord extends BaseRecord {
  organization_id: string;
  title: string;
  /** 可读稳定代码，如 CC_SG_202608_01（PRD 附录 B）。 */
  activity_code: string;
  description?: string;
  location?: string;
  start_time: string;
  end_time: string;
  status: ActivityStatus;
  /** 总名额硬限制；不得低于当前已通过人数（FR-ACT-006）。 */
  capacity_total: number;
  capacity_speaker: number;
  capacity_listener: number;
  /** 报名手动开关（FR-ACT-005）。 */
  registration_open: boolean;
  registration_start_at?: string;
  registration_end_at?: string;
  /** 固定签到二维码 token，全活动周期不变（FR-CHK-001）。 */
  checkin_qr_token: string;
  /** 预留分组字段（可空），V1 不消费（PRD §4.1）。 */
  group_tag?: string;
  /** 活动级报名字段启用/必填配置（草案，database-design D-3）。 */
  form_config_json?: unknown;
}

// ---------- 5.2.6 activity_approvals — 活动发布审核历史（只追加） ----------

export type ApprovalAction = 'submit' | 'approve' | 'reject';

export interface ActivityApprovalRecord extends BaseRecord {
  activity_id: string;
  /** 审核人（超级管理员 id）；提交动作时为提交的管理员 id。 */
  reviewer_id: string;
  action: ApprovalAction;
  /** 驳回必填原因（PRD §4.3）。 */
  reason?: string;
}

// ---------- 5.2.7 registration_field_defs — 报名字段定义 ----------

export interface RegistrationFieldDefRecord extends BaseRecord {
  /** null = 平台标准字段（超管维护）；非 null = 机构自定义字段（PRD §8.1）。 */
  organization_id?: string;
  field_code: string;
  field_type: FieldType;
  label: string;
  source_type: SourceType;
  /** 敏感标记：普通导出按此排除/掩码，不依赖字段名判断（FR-EXP-002）。 */
  is_sensitive: boolean;
  options_json?: unknown;
  required_default: boolean;
  status: ActiveStatus;
}

// ---------- 5.2.8 registrations — 报名、角色与审核状态 ----------

export interface RegistrationRecord extends BaseRecord {
  activity_id: string;
  participant_id: string;
  activity_role: ActivityRole;
  status: RegistrationStatus;
  submitted_at: string;
  /** 最近一次状态变更原因（取消/回退必填，FR-REG-008）。 */
  status_reason?: string;
}

// ---------- 5.2.9 registration_answers — 报名字段答案 ----------

export interface RegistrationAnswerRecord extends BaseRecord {
  registration_id: string;
  field_def_id: string;
  /** 答案值；多选用标准 JSON 数组（PRD §10.3）。 */
  value_json: unknown;
}

// ---------- 5.2.10 checkin_sessions — 签到开放状态 ----------

export interface CheckinSessionRecord extends BaseRecord {
  activity_id: string;
  status: CheckinSessionStatus;
  opened_at: string;
  closed_at?: string;
  /** 操作管理员 id。 */
  opened_by: string;
}

// ---------- 5.2.11 checkins — 签到记录 ----------

export interface CheckinRecord extends BaseRecord {
  activity_id: string;
  participant_id: string;
  registration_id: string;
  source: CheckinSource;
  status: CheckinStatus;
  checked_in_at: string;
  /** 补签/撤销操作管理员 id；自助签到为空。 */
  operator_id?: string;
  /** 补签/撤销必填原因（FR-CHK-005）。 */
  reason?: string;
  revoked_at?: string;
}

// ---------- 5.2.12 survey_templates — 标准模板索引 ----------

export interface SurveyTemplateRecord extends BaseRecord {
  /** 大写下划线，如 PARTICIPANT_PRE_V1（PRD 附录 B）。 */
  template_code: string;
  name: string;
  description?: string;
  current_version_id: string;
  status: ActiveStatus;
}

// ---------- 5.2.13 survey_template_versions — 不可变模板版本 ----------

export interface SurveyTemplateVersionRecord extends BaseRecord {
  template_id: string;
  version: number;
  /** 题目完整定义快照（含 question_code、题型、选项、locked、is_sensitive）。 */
  schema_json: unknown;
  published_at: string;
  published_by: string;
}

// ---------- 5.2.14 activity_surveys — 活动问卷与独立入口 ----------

export interface ActivitySurveyRecord extends BaseRecord {
  activity_id: string;
  template_version_id: string;
  /** 活动问卷稳定代码，如 CC_SG_202608_01_PRE。 */
  survey_code: string;
  title: string;
  role_scope: RoleScope;
  status: SurveyStatus;
  /** 独立链接/二维码 token，不可连续可猜（PRD §10.3）。 */
  qr_token: string;
  opened_at?: string;
  ended_at?: string;
}

// ---------- 5.2.15 survey_questions — 活动问卷题目 ----------

export interface SurveyQuestionRecord extends BaseRecord {
  activity_survey_id: string;
  /** 稳定机器字段：标准题跨模板/跨活动一致；自定义题活动内唯一（PRD §8.3）。 */
  question_code: string;
  source_type: SourceType;
  question_type: QuestionType;
  title: string;
  required: boolean;
  options_json?: unknown;
  /** 核心锁定题：机构不能修改或删除（FR-SUR-001）。 */
  locked: boolean;
  /** 敏感标记：普通导出过滤依据（FR-SUR-012）。 */
  is_sensitive: boolean;
  order_index: number;
  validation_json?: unknown;
}

// ---------- 5.2.16 submissions — 答卷 ----------

export interface SubmissionRecord extends BaseRecord {
  activity_survey_id: string;
  participant_id: string;
  registration_id: string;
  status: SubmissionStatus;
  /** 正式提交时间；草稿为空。 */
  submitted_at?: string;
  voided_by?: string;
  voided_at?: string;
  void_reason?: string;
}

// ---------- 5.2.17 answers — 题目答案 ----------

export interface AnswerRecord extends BaseRecord {
  submission_id: string;
  /** 冗余存储：导出直接按 question_code 关联，历史答案不受题目调整影响（PRD §9.2）。 */
  question_code: string;
  value_json: unknown;
}

// ---------- 5.2.18 export_jobs — 导出任务与文件 ----------

/** 导出范围（scope_json）：服务端按身份校验允许范围（FR-EXP-004）。 */
export interface ExportScope {
  type: 'platform' | 'organization' | 'activity';
  activity_id?: string;
  date_range?: { from: string; to: string };
}

export interface ExportJobRecord extends BaseRecord {
  /** 导出主机构；超级管理员全平台导出时为 null。 */
  organization_id?: string;
  scope_json: ExportScope;
  /** 是否敏感导出；true 需机构开关 + 二次确认 + 审计（FR-EXP-003、AC-17）。 */
  include_pii: boolean;
  /** ZIP 存放路径（受保护目录，仅鉴权后下载，FR-EXP-005）。 */
  file_path: string;
  file_checksum?: string;
  status: ExportStatus;
  created_by: string;
}

// ---------- 5.2.19 audit_logs — 不可变审计记录 ----------

export interface AuditLogRecord extends BaseRecord {
  actor_id: string;
  actor_role: AuditActorRole;
  /** 涉事机构；平台级事件可为 null。 */
  organization_id?: string;
  /** 动作代码（如 registration.status_revert），枚举见 security-privacy §8。 */
  action: string;
  target_type: string;
  target_id: string;
  result: AuditResult;
  /** 高风险操作原因（补签/回退/作废等必填）。 */
  reason?: string;
  /** 前后状态、上下文；不得含密码或完整敏感答案（PRD §11.2）。 */
  metadata?: unknown;
}
