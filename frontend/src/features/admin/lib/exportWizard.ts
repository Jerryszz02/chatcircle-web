import type {
  ExportDataset,
  ExportFormat,
  ExportQuestionSelection,
  ExportSelectionV2,
  ExportSystemColumn,
} from '../../../shared/api/accountEvent';
import type { ActivityRole, RegistrationStatus } from '../../../shared/api/types';

/**
 * T6 五步导出向导的纯逻辑（PRD §7、api-design §6）。
 *
 * 本模块只做状态组装/校验/预设展开，不做任何敏感判定承诺——
 * requires_sensitive_export 与权限一律以服务端 preview/create 返回为准
 * （前端布尔值不是门槛，api-design §6.2）。
 */

// ---------- 步骤与选项 ----------

export const EXPORT_WIZARD_STEPS = ['范围', '数据域', '行筛选', '字段', '格式'] as const;

export const EXPORT_DATASET_LABELS: Record<ExportDataset, string> = {
  registrations: '报名',
  checkins: '签到',
  pairings: '配对',
  surveys: '问卷',
};

export const EXPORT_SYSTEM_COLUMN_LABELS: Record<ExportSystemColumn, string> = {
  participant_id: '参与者 ID',
  activity_id: '活动 ID',
  activity_role: '活动内角色',
  registration_status: '报名状态',
  checked_in_at: '签到时间',
  onsite_code: '现场编号',
  pair_code: '配对编号',
  partner_name: '搭档姓名（敏感）',
  phone_masked: '掩码手机号',
  phone_full: '完整手机号（敏感）',
};

/** 敏感系统列（仅 UI 提示用；服务端判敏才是唯一门槛）。 */
export const SENSITIVE_SYSTEM_COLUMNS: ReadonlySet<ExportSystemColumn> = new Set([
  'phone_full',
  'partner_name',
]);

export const CHECKIN_FILTER_OPTIONS = [
  { value: 'any', label: '不限' },
  { value: 'valid', label: '已签到' },
  { value: 'not_checked_in', label: '未签到' },
  { value: 'revoked', label: '已撤销签到' },
] as const;

export const PAIRING_FILTER_OPTIONS = [
  { value: 'any', label: '不限' },
  { value: 'paired', label: '已配对' },
  { value: 'waiting', label: '待配对（已签到未配对）' },
  { value: 'unpaired', label: '未配对' },
] as const;

export const SURVEY_COMPLETION_OPTIONS = [
  { value: 'any', label: '不限' },
  { value: 'submitted', label: '已提交问卷' },
  { value: 'not_submitted', label: '未提交问卷' },
] as const;

export const REGISTRATION_STATUS_OPTIONS: Array<{ value: RegistrationStatus; label: string }> = [
  { value: 'pending', label: '待审核' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'cancelled', label: '已取消' },
];

export const ACTIVITY_ROLE_OPTIONS: Array<{ value: ActivityRole; label: string }> = [
  { value: 'speaker', label: '倾诉者' },
  { value: 'listener', label: '聆听者' },
];

export const EXPORT_TIMEZONES = ['Asia/Shanghai', 'UTC'] as const;

// ---------- 预设模板（PRD §7） ----------

export type ExportPresetCode =
  | 'contact_list'
  | 'checkin_list'
  | 'onsite_pairs'
  | 'participant_structure'
  | 'single_survey'
  | 'activity_full'
  | 'participant_profile';

export interface ExportPreset {
  code: ExportPresetCode;
  label: string;
  description: string;
  datasets: ExportDataset[];
  system: ExportSystemColumn[];
  /** 展开时纳入全部非敏感报名字段（敏感字段仍需显式勾选）。 */
  allNonSensitiveFields?: boolean;
  /** 展开时纳入所选问卷的全部非敏感题目。 */
  allNonSensitiveQuestions?: boolean;
  /** 展开时纳入 FULL_NAME（敏感，触发敏感导出流程）。 */
  includeFullName?: boolean;
  /** 行筛选预设。 */
  filters?: Partial<
    Pick<ExportWizardState, 'checkin' | 'pairing' | 'surveyCompletion'>
  >;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  {
    code: 'contact_list',
    label: '联系名单',
    description: '姓名 + 掩码手机号 + 审核状态（含敏感字段，需机构开关与二次确认）',
    datasets: ['registrations'],
    system: ['participant_id', 'activity_role', 'registration_status', 'phone_masked'],
    includeFullName: true,
  },
  {
    code: 'checkin_list',
    label: '签到名单',
    description: '签到时间、现场编号与签到明细（默认不含姓名/手机号）',
    datasets: ['registrations', 'checkins'],
    system: ['participant_id', 'activity_role', 'registration_status', 'checked_in_at', 'onsite_code'],
  },
  {
    code: 'onsite_pairs',
    label: '现场配对表',
    description: '现场编号、配对编号与搭档姓名（含敏感列，需二次确认）',
    datasets: ['registrations', 'pairings'],
    system: ['participant_id', 'activity_role', 'onsite_code', 'pair_code', 'partner_name'],
    filters: { checkin: 'valid' },
  },
  {
    code: 'participant_structure',
    label: '参与者结构数据',
    description: '角色/状态构成，附性别与年龄段报名字段（聚合分析用，不含身份列）',
    datasets: ['registrations'],
    system: ['participant_id', 'activity_role', 'registration_status'],
    allNonSensitiveFields: true,
  },
  {
    code: 'single_survey',
    label: '单份问卷结果',
    description: '选定一份问卷的非敏感题目结果（敏感题需显式勾选）',
    datasets: ['surveys'],
    system: ['participant_id'],
    allNonSensitiveQuestions: true,
  },
  {
    code: 'activity_full',
    label: '活动完整复盘',
    description: '报名/签到/配对/全部问卷的非敏感全景（敏感字段与题目需显式勾选）',
    datasets: ['registrations', 'checkins', 'pairings', 'surveys'],
    system: [
      'participant_id', 'activity_id', 'activity_role', 'registration_status',
      'checked_in_at', 'onsite_code', 'pair_code', 'phone_masked',
    ],
    allNonSensitiveFields: true,
    allNonSensitiveQuestions: true,
  },
  {
    code: 'participant_profile',
    label: '指定参与者资料',
    description: '按参与者 ID 行筛选的完整资料（含姓名等敏感字段，需二次确认）',
    datasets: ['registrations', 'checkins', 'pairings', 'surveys'],
    system: ['participant_id', 'activity_role', 'registration_status', 'checked_in_at', 'phone_masked'],
    includeFullName: true,
    allNonSensitiveFields: true,
    allNonSensitiveQuestions: true,
  },
];

// ---------- 向导状态 ----------

export interface ExportWizardState {
  preset: ExportPresetCode | '';
  scopeType: 'organization' | 'activity';
  activityId: string;
  dateFrom: string;
  dateTo: string;
  datasets: ExportDataset[];
  /** 空 = 范围内全部问卷。 */
  surveyIds: string[];
  roles: ActivityRole[];
  statuses: RegistrationStatus[];
  checkin: 'any' | 'valid' | 'not_checked_in' | 'revoked';
  pairing: 'any' | 'paired' | 'waiting' | 'unpaired';
  surveyCompletion: 'any' | 'submitted' | 'not_submitted';
  /** 指定参与者 ID 输入框原文（行筛选，逗号/空白/换行分隔）。 */
  participantIdsText: string;
  systemColumns: ExportSystemColumn[];
  fieldCodes: string[];
  questionSelections: ExportQuestionSelection[];
  format: ExportFormat;
  timezone: string;
}

export function initialExportWizardState(): ExportWizardState {
  return {
    preset: '',
    scopeType: 'organization',
    activityId: '',
    dateFrom: '',
    dateTo: '',
    datasets: ['registrations'],
    surveyIds: [],
    roles: [],
    statuses: [],
    checkin: 'any',
    pairing: 'any',
    surveyCompletion: 'any',
    participantIdsText: '',
    systemColumns: ['participant_id', 'activity_role', 'registration_status'],
    fieldCodes: [],
    questionSelections: [],
    format: 'xlsx',
    timezone: 'Asia/Shanghai',
  };
}

// ---------- 预设展开 ----------

export interface ExportFieldMeta {
  field_code: string;
  is_sensitive: boolean;
}

export interface ExportQuestionMeta {
  activity_survey_id: string;
  question_code: string;
  is_sensitive: boolean;
}

/**
 * 把预设展开为状态补丁。敏感字段/题目永不自动勾选（only 非敏感全集选项）；
 * FULL_NAME 属敏感字段，仅 includeFullName 预设显式纳入。
 */
export function applyExportPreset(
  preset: ExportPreset,
  meta: { fields: ExportFieldMeta[]; questions: ExportQuestionMeta[] },
): Partial<ExportWizardState> {
  const fieldCodes = preset.allNonSensitiveFields
    ? meta.fields.filter((f) => !f.is_sensitive).map((f) => f.field_code)
    : [];
  if (preset.includeFullName && meta.fields.some((f) => f.field_code === 'FULL_NAME')) {
    fieldCodes.push('FULL_NAME');
  }
  const questionSelections: ExportQuestionSelection[] = [];
  if (preset.allNonSensitiveQuestions) {
    const bySurvey = new Map<string, string[]>();
    meta.questions.forEach((q) => {
      if (q.is_sensitive) return;
      const list = bySurvey.get(q.activity_survey_id) ?? [];
      list.push(q.question_code);
      bySurvey.set(q.activity_survey_id, list);
    });
    bySurvey.forEach((codes, sid) => questionSelections.push({ activity_survey_id: sid, question_codes: codes }));
  }
  return {
    preset: preset.code,
    datasets: [...preset.datasets],
    systemColumns: [...preset.system],
    fieldCodes,
    questionSelections,
    checkin: preset.filters?.checkin ?? 'any',
    pairing: preset.filters?.pairing ?? 'any',
    surveyCompletion: preset.filters?.surveyCompletion ?? 'any',
  };
}

// ---------- 解析与组装 ----------

const PARTICIPANT_ID_RE = /^[A-Za-z0-9_]+$/;

/** 解析指定参与者输入：逗号/空白/换行分隔，去重，保序。 */
export function parseParticipantIds(text: string): { ids: string[]; invalid: string[] } {
  const ids: string[] = [];
  const invalid: string[] = [];
  text
    .split(/[\s,，、;；]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((token) => {
      if (!PARTICIPANT_ID_RE.test(token)) {
        invalid.push(token);
        return;
      }
      if (!ids.includes(token)) ids.push(token);
    });
  return { ids, invalid };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 组装 ExportSelectionV2（冻结契约形状）。 */
export function buildExportSelection(state: ExportWizardState): ExportSelectionV2 {
  const scope: ExportSelectionV2['scope'] =
    state.scopeType === 'activity'
      ? { type: 'activity', activity_id: state.activityId }
      : { type: 'organization' };
  const dateRange: { from?: string; to?: string } = {};
  if (state.dateFrom) dateRange.from = state.dateFrom;
  if (state.dateTo) dateRange.to = state.dateTo;
  if (dateRange.from || dateRange.to) scope.date_range = dateRange;

  const { ids } = parseParticipantIds(state.participantIdsText);
  return {
    schema_version: 2,
    scope,
    datasets: [...state.datasets],
    survey_ids: [...state.surveyIds],
    filters: {
      participant_ids: ids,
      activity_roles: [...state.roles],
      registration_statuses: [...state.statuses],
      checkin: state.checkin,
      pairing: state.pairing,
      survey_completion: state.surveyCompletion,
    },
    columns: {
      system: [...state.systemColumns],
      registration_field_codes: [...state.fieldCodes],
      survey_questions: state.questionSelections.map((q) => ({
        activity_survey_id: q.activity_survey_id,
        question_codes: [...q.question_codes],
      })),
    },
    format: state.format,
    timezone: state.timezone,
  };
}

// ---------- 分步校验 ----------

/** 校验指定步骤，返回错误文案列表（空 = 可进入下一步）。 */
export function validateExportWizardStep(state: ExportWizardState, step: number): string[] {
  const errors: string[] = [];
  if (step === 1) {
    if (state.scopeType === 'activity' && !state.activityId) errors.push('请选择要导出的活动');
    if (state.dateFrom && !DATE_RE.test(state.dateFrom)) errors.push('开始日期须为 YYYY-MM-DD');
    if (state.dateTo && !DATE_RE.test(state.dateTo)) errors.push('结束日期须为 YYYY-MM-DD');
    if (state.dateFrom && state.dateTo && state.dateFrom > state.dateTo) {
      errors.push('开始日期不能晚于结束日期');
    }
  } else if (step === 2) {
    if (state.datasets.length === 0) errors.push('请至少选择一个数据域');
    if (state.scopeType !== 'activity' && state.datasets.includes('surveys') && state.surveyIds.length === 0) {
      // 机构范围允许全部问卷，仅提示性约束，不拦截
    }
  } else if (step === 3) {
    const { invalid } = parseParticipantIds(state.participantIdsText);
    if (invalid.length > 0) errors.push(`参与者 ID 含非法字符：${invalid.join('、')}`);
  } else if (step === 4) {
    const needsColumns = state.datasets.includes('registrations') || state.datasets.includes('surveys');
    const hasColumns =
      state.systemColumns.length > 0 || state.fieldCodes.length > 0 || state.questionSelections.length > 0;
    if (needsColumns && !hasColumns) errors.push('请至少选择一个系统列、报名字段或问卷题目');
    if (!state.datasets.includes('surveys') && state.questionSelections.length > 0) {
      errors.push('未选问卷数据域时不能选择问卷题目');
    }
  } else if (step === 5) {
    if (!state.format) errors.push('请选择导出格式');
    if (!state.timezone) errors.push('请选择时区');
  }
  return errors;
}

// ---------- UI 提示（非门槛） ----------

/**
 * 客户端敏感提示（仅展示）：命中的敏感列/字段/题目代码。
 * 判敏唯一权威是服务端 preview/create 返回的 requires_sensitive_export。
 */
export function clientSensitiveHints(
  state: ExportWizardState,
  meta: { fields: ExportFieldMeta[]; questions: ExportQuestionMeta[] },
): string[] {
  const hits: string[] = [];
  state.systemColumns.forEach((col) => {
    if (SENSITIVE_SYSTEM_COLUMNS.has(col)) hits.push(col);
  });
  state.fieldCodes.forEach((code) => {
    const def = meta.fields.find((f) => f.field_code === code);
    if (def?.is_sensitive) hits.push(code);
  });
  state.questionSelections.forEach((qs) => {
    qs.question_codes.forEach((qc) => {
      const q = meta.questions.find(
        (m) => m.activity_survey_id === qs.activity_survey_id && m.question_code === qc,
      );
      if (q?.is_sensitive) hits.push(qc);
    });
  });
  return hits;
}
