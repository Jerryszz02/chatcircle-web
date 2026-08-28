import type {
  ActiveStatus,
  ActivityRole,
  BaseRecord,
  CheckinRecord,
  RegistrationStatus,
} from './types';

/**
 * 手机号账号与活动现场升级的 T0 共享契约。
 *
 * 这些类型描述冻结契约；T3 的 live-summary 与管理端 Realtime 失效化已落地，
 * 其余 T1/T2/T6 schema 与端点仍须先复用本文件再实现，禁止在 feature 内另造同义字段。
 * 权威语义与迁移顺序见 docs/planning/api-design.md 与 database-design.md。
 */

export const ACCOUNT_EVENT_CONTRACT_VERSION = '2026-08-28.t0-v1' as const;

// ---------- 手机号账号 ----------

export type PhoneBindingSource = 'sms_signup' | 'legacy_bind' | 'manual_merge';
export type PhoneMigrationStatus = 'legacy_unbound' | 'phone_bound' | 'merge_required';
export type PhoneCodePurpose = 'login_or_register' | 'bind_phone' | 'change_phone';

/** participant_accounts 的服务端持久化字段；T1 迁移前均不存在。 */
export interface ParticipantPhonePersistenceFields {
  /** 中国大陆手机号的 E.164 形式，例如 +8613812345678。 */
  phone_e164?: string;
  /** HMAC-SHA256(deployment secret, phone_e164)；唯一索引与精确查找使用此字段。 */
  phone_lookup_hash?: string;
  phone_verified_at?: string;
  phone_binding_source?: PhoneBindingSource;
  phone_migration_status: PhoneMigrationStatus;
}

/** 普通客户端可读取的本人手机号状态；完整手机号和查找 hash 不进入 auth 响应。 */
export interface ParticipantPhonePublicFields {
  phone_masked?: string;
  phone_verified_at?: string;
  phone_binding_source?: PhoneBindingSource;
  phone_migration_status: PhoneMigrationStatus;
}

/** 手机号认证响应中的公开账号形状；内部 username/password 永不下发。 */
export interface ParticipantPhoneAuthRecord extends BaseRecord, ParticipantPhonePublicFields {
  status: ActiveStatus;
}

export interface RequestPhoneCodeInput {
  /** API 接收 11 位大陆手机号或 +86 E.164，服务端统一归一化。 */
  phone: string;
  purpose: PhoneCodePurpose;
  /** login_or_register 首次请求时必填；服务端存版本号而不信任布尔值。 */
  privacy_notice_version?: string;
}

/** 对已注册与未注册手机号返回同一形状，防止账号枚举。 */
export interface RequestPhoneCodeResponse {
  contract_version: typeof ACCOUNT_EVENT_CONTRACT_VERSION;
  accepted: true;
  challenge_id: string;
  expires_in_seconds: number;
  retry_after_seconds: number;
}

export interface VerifyPhoneCodeInput {
  phone: string;
  challenge_id: string;
  code: string;
  privacy_notice_version?: string;
}

export interface ParticipantPhoneAuthResponse {
  contract_version: typeof ACCOUNT_EVENT_CONTRACT_VERSION;
  token: string;
  record: ParticipantPhoneAuthRecord;
  created: boolean;
}

export interface BindPhoneInput {
  phone: string;
  challenge_id: string;
  code: string;
}

export interface BindPhoneResponse {
  contract_version: typeof ACCOUNT_EVENT_CONTRACT_VERSION;
  participant_id: string;
  phone_masked: string;
  phone_verified_at: string;
  phone_migration_status: 'phone_bound';
}

export type ChangePhoneInput = BindPhoneInput &
  (
    | {
        verification_method: 'old_phone';
        old_phone_challenge_id: string;
        old_phone_code: string;
      }
    | {
        verification_method: 'support';
        support_ticket_id: string;
      }
  );

// ---------- 报名标准字段 ----------

export type StandardFieldAnalysisUsage = 'contact_and_pairing_only' | 'aggregate_only';

export interface StandardRegistrationFieldContract {
  field_code: 'FULL_NAME' | 'GENDER' | 'AGE_RANGE';
  field_type: 'text' | 'single_choice';
  label: string;
  source_type: 'standard';
  is_sensitive: boolean;
  required_default: boolean;
  role_scope: 'both';
  analysis_usage: StandardFieldAnalysisUsage;
  options_json?: ReadonlyArray<{ value: string; label: string }>;
}

/**
 * T0 冻结的三个平台标准报名字段。年龄只收集年龄段，不收集出生日期/完整生日。
 * FULL_NAME 是敏感且默认必填；GENDER/AGE_RANGE 只能用于阈值为 5 的聚合统计。
 */
export const STANDARD_REGISTRATION_FIELDS = [
  {
    field_code: 'FULL_NAME',
    field_type: 'text',
    label: '姓名',
    source_type: 'standard',
    is_sensitive: true,
    required_default: true,
    role_scope: 'both',
    analysis_usage: 'contact_and_pairing_only',
  },
  {
    field_code: 'GENDER',
    field_type: 'single_choice',
    label: '性别',
    source_type: 'standard',
    is_sensitive: false,
    required_default: false,
    role_scope: 'both',
    analysis_usage: 'aggregate_only',
    options_json: [
      { value: 'female', label: '女' },
      { value: 'male', label: '男' },
      { value: 'other', label: '其他' },
      { value: 'prefer_not_to_say', label: '不愿透露' },
    ],
  },
  {
    field_code: 'AGE_RANGE',
    field_type: 'single_choice',
    label: '年龄段',
    source_type: 'standard',
    is_sensitive: false,
    required_default: false,
    role_scope: 'both',
    analysis_usage: 'aggregate_only',
    options_json: [
      { value: 'under_18', label: '18 岁以下' },
      { value: '18_24', label: '18–24 岁' },
      { value: '25_34', label: '25–34 岁' },
      { value: '35_44', label: '35–44 岁' },
      { value: '45_54', label: '45–54 岁' },
      { value: '55_plus', label: '55 岁及以上' },
      { value: 'prefer_not_to_say', label: '不愿透露' },
    ],
  },
] as const satisfies ReadonlyArray<StandardRegistrationFieldContract>;

export type StandardRegistrationFieldCode =
  (typeof STANDARD_REGISTRATION_FIELDS)[number]['field_code'];

// ---------- 现场编号与配对 ----------

export type PairingStatus = 'active' | 'released' | 'completed';

/** checkins 的目标追加字段；发出后即使撤销签到也不复用。 */
export interface CheckinNumberingFields {
  onsite_role?: ActivityRole;
  onsite_sequence?: number;
  numbered_at?: string;
}

export type TargetCheckinRecord = CheckinRecord & CheckinNumberingFields;

export interface ActivityPairRecord extends BaseRecord {
  activity_id: string;
  pair_sequence: number;
  speaker_registration_id: string;
  listener_registration_id: string;
  speaker_checkin_id: string;
  listener_checkin_id: string;
  status: PairingStatus;
  paired_at: string;
  paired_by: string;
  /** 手工调整产生的新配对必填；首次自动配对为空。 */
  adjustment_reason?: string;
  released_at?: string;
  released_by?: string;
  release_reason?: string;
  completed_at?: string;
}

export interface ActivityOnsiteStateFields {
  pairing_started_at?: string;
  pairing_started_by?: string;
  onsite_locked_at?: string;
  onsite_locked_by?: string;
}

/** activities 的服务端现场持久化字段；两个计数器不得进入客户端快照。 */
export interface ActivityOnsitePersistenceFields extends ActivityOnsiteStateFields {
  next_speaker_sequence: number;
  next_listener_sequence: number;
}

export interface RoleCounts {
  total: number;
  speaker: number;
  listener: number;
}

export interface RegistrationFunnel {
  total: RoleCounts;
  pending: RoleCounts;
  approved: RoleCounts;
  rejected: RoleCounts;
  cancelled: RoleCounts;
}

export interface CompletionMetric {
  eligible: number;
  submitted: number;
  /** 分母为 0 时必须返回 null，有值时范围是 [0, 1]。 */
  rate: number | null;
}

export interface SuppressedBucket {
  key: string;
  count: number | null;
  suppressed: boolean;
}

export interface ActivityLiveSummaryResponse {
  contract_version: typeof ACCOUNT_EVENT_CONTRACT_VERSION;
  activity_id: string;
  generated_at: string;
  onsite: ActivityOnsiteStateFields;
  registrations: RegistrationFunnel;
  checkins: {
    approved: RoleCounts;
    valid: RoleCounts;
    rate: { total: number | null; speaker: number | null; listener: number | null };
  };
  pairings: {
    active_pairs: number;
    waiting: RoleCounts;
    imbalance: number;
  };
  surveys: Array<{
    activity_survey_id: string;
    title: string;
    onsite_completion: CompletionMetric;
    overall_completion: CompletionMetric;
  }>;
  demographics: {
    suppression_threshold: 5;
    gender: SuppressedBucket[];
    age_range: SuppressedBucket[];
  };
  recent_checkins: Array<{
    checkin_id: string;
    participant_id: string;
    display_name: string;
    onsite_code: string;
    checked_in_at: string;
    status: 'valid' | 'revoked';
  }>;
}

export type MyPairingState =
  | 'not_checked_in'
  | 'waiting_to_start'
  | 'waiting_for_partner'
  | 'paired'
  | 'reassigned'
  | 'checkin_revoked';

export interface MyPairingResponse {
  contract_version: typeof ACCOUNT_EVENT_CONTRACT_VERSION;
  activity_id: string;
  state: MyPairingState;
  onsite_code?: string;
  pair_code?: string;
  partner?: {
    onsite_code: string;
    /** 只能来自搭档该场报名的 FULL_NAME，不从账号层复用。 */
    display_name: string;
  };
  updated_at: string;
}

export interface PairingsStartResponse {
  contract_version: typeof ACCOUNT_EVENT_CONTRACT_VERSION;
  activity_id: string;
  already_started: boolean;
  created_pairs: number;
  active_pairs: number;
  waiting: RoleCounts;
}

export interface PairingReassignInput {
  speaker_checkin_id: string;
  listener_checkin_id: string;
  reason: string;
}

export interface PairingReassignResponse {
  contract_version: typeof ACCOUNT_EVENT_CONTRACT_VERSION;
  activity_id: string;
  released_pair_ids: string[];
  pairing: ActivityPairRecord;
}

export interface OnsiteLockResponse {
  contract_version: typeof ACCOUNT_EVENT_CONTRACT_VERSION;
  activity_id: string;
  already_locked: boolean;
  onsite: ActivityOnsiteStateFields;
}

// ---------- 细粒度导出 ----------

export type ExportDataset = 'registrations' | 'checkins' | 'pairings' | 'surveys';
export type ExportFormat = 'xlsx' | 'csv_zip';
export type ExportSystemColumn =
  | 'participant_id'
  | 'activity_id'
  | 'activity_role'
  | 'registration_status'
  | 'checked_in_at'
  | 'onsite_code'
  | 'pair_code'
  | 'partner_name'
  | 'phone_masked'
  | 'phone_full';

export interface ExportScopeV2 {
  type: 'platform' | 'organization' | 'activity';
  organization_id?: string;
  activity_id?: string;
  date_range?: { from?: string; to?: string };
}

export interface ExportFiltersV2 {
  participant_ids?: string[];
  activity_roles?: ActivityRole[];
  registration_statuses?: RegistrationStatus[];
  checkin?: 'any' | 'valid' | 'not_checked_in' | 'revoked';
  pairing?: 'any' | 'paired' | 'waiting' | 'unpaired';
  survey_completion?: 'any' | 'submitted' | 'not_submitted';
}

export interface ExportQuestionSelection {
  activity_survey_id: string;
  question_codes: string[];
}

export interface ExportSelectionV2 {
  schema_version: 2;
  scope: ExportScopeV2;
  datasets: ExportDataset[];
  /** surveys 数据域为空时表示范围内全部问卷。 */
  survey_ids?: string[];
  filters: ExportFiltersV2;
  columns: {
    system: ExportSystemColumn[];
    registration_field_codes: string[];
    survey_questions: ExportQuestionSelection[];
  };
  format: ExportFormat;
  timezone: string;
}

/** export_jobs.scope_json 的服务端持久化形状；来源版本不得由客户端指定。 */
export interface StoredExportSelectionV2 extends ExportSelectionV2 {
  source_schema_version: 1 | 2;
}

/** 旧客户端请求继续受理，服务端内部归一化为 v2 后再做权限与敏感性判定。 */
export interface LegacyExportRequest {
  scope: {
    type: 'platform' | 'organization' | 'activity';
    organization_id?: string;
    activity_id?: string;
    date_range?: { from?: string; to?: string };
  };
  include_pii: boolean;
  confirm?: boolean;
}

export interface SensitiveExportReason {
  source: 'account_column' | 'registration_field' | 'survey_question';
  code: string;
}

export interface ExportPreviewResponse {
  contract_version: typeof ACCOUNT_EVENT_CONTRACT_VERSION;
  normalized_selection: ExportSelectionV2;
  estimated_rows: Partial<Record<ExportDataset, number>>;
  requires_sensitive_export: boolean;
  sensitive_reasons: SensitiveExportReason[];
  permission: {
    allowed: boolean;
    code?: 'not_found' | 'sensitive_export_disabled';
  };
}

export interface CreateExportV2Input extends ExportSelectionV2 {
  /** requires_sensitive_export=true 时必须显式为 true；服务端仍会重算敏感性。 */
  confirm_sensitive?: boolean;
}

export interface CreateExportV2Response {
  contract_version: typeof ACCOUNT_EVENT_CONTRACT_VERSION;
  export_job_id: string;
  status: 'running';
  requires_sensitive_export: boolean;
  normalized_selection: ExportSelectionV2;
}

// ---------- 端点与 Realtime 无效化契约 ----------

const activityPath = (activityId: string, suffix: string) =>
  `/api/cc/activities/${encodeURIComponent(activityId)}${suffix}`;

export const ACCOUNT_EVENT_ENDPOINTS = {
  requestPhoneCode: '/api/cc/auth/participant/request-code',
  verifyPhoneCode: '/api/cc/auth/participant/verify-code',
  bindPhone: '/api/cc/auth/participant/bind-phone',
  changePhone: '/api/cc/auth/participant/change-phone',
  exportPreview: '/api/cc/exports/preview',
  createExport: '/api/cc/exports',
  activityLiveSummary: (activityId: string) => activityPath(activityId, '/live-summary'),
  startPairings: (activityId: string) => activityPath(activityId, '/pairings/start'),
  reassignPairing: (activityId: string) => activityPath(activityId, '/pairings/reassign'),
  myPairing: (activityId: string) => activityPath(activityId, '/my-pairing'),
  lockOnsite: (activityId: string) => activityPath(activityId, '/onsite/lock'),
} as const;

/**
 * Realtime 只做“数据已变更”信号；前端不用 event.record 重算指标或拼配对。
 * 订阅必须先建立，再拉取快照；任一事件防抖后重拉，断线恢复时无条件重拉。
 */
export const ACTIVITY_LIVE_REALTIME_SOURCES = [
  'registrations',
  'checkins',
  'submissions',
  'activity_pairs',
] as const;

/** participant 不得订阅 activity_pairs；自定义 topic 只发送无敏感字段的失效化消息。 */
export const PARTICIPANT_PAIRING_REALTIME_SOURCES = ['checkins', 'cc.participant.pairing'] as const;

export const participantPairingRealtimeTopic = (participantId: string) =>
  `cc.participant.pairing.${encodeURIComponent(participantId)}`;

export interface ParticipantPairingInvalidationMessage {
  contract_version: typeof ACCOUNT_EVENT_CONTRACT_VERSION;
  activity_id: string;
  changed_at: string;
}
