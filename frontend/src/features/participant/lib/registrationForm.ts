import type { ActivityRole, FieldType, RoleScope, SourceType } from '../../../shared/api/types';
import type { PublicRegistrationField, RegistrationAnswerInput } from '../api';
import { parseChoiceOptions, type ChoiceOption } from './choiceOptions';

/**
 * 报名表渲染与校验逻辑（FR-REG-001/002/004）。
 * 字段清单与生效必填由服务端经公开活动端点下发（标准字段 + 机构自定义字段）；
 * 本模块负责：渲染模型构建（选项解析、敏感标记、按角色过滤）、按题型校验、提交载荷组装。
 * 角色维度：role_scope=both 的字段任何角色都作答；speaker/listener 字段仅对应角色作答，
 * 未选角色时只出现 both 字段；切换角色后不再适用的字段不渲染、不校验、不提交。
 * 前端校验仅作体验层提示，服务端重新校验（technical-design §5.5）。
 */

/** 报名表单字段渲染模型（由 PublicRegistrationField 转换而来）。 */
export interface RegistrationFieldModel {
  id: string;
  fieldCode: string;
  fieldType: FieldType;
  label: string;
  sourceType: SourceType;
  /** 敏感字段：普通导出不包含，仅经参与者知情后的敏感导出可见（security-privacy §4）。 */
  isSensitive: boolean;
  required: boolean;
  /** 适用角色（both / speaker / listener）。 */
  roleScope: RoleScope;
  /** 选项（仅 single_choice / multi_choice 有值）。 */
  options: ChoiceOption[];
  config?: RegistrationFieldConfig;
}

export interface RegistrationFieldConfig {
  input_type?: 'email' | 'tel' | 'textarea' | 'ack';
  hint?: string;
  section?: string;
  order_index?: number;
  show_when?: { field_code: string; value: string };
}

/** 表单值（key = field_def_id）：text/number/date/single_choice 为 string，multi_choice 为 string[]。 */
export type RegistrationFormValues = Record<string, string | string[]>;

function parseFieldConfig(raw: unknown): RegistrationFieldConfig | undefined {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const config: RegistrationFieldConfig = {};
  if (['email', 'tel', 'textarea', 'ack'].includes(String(input.input_type))) {
    config.input_type = input.input_type as RegistrationFieldConfig['input_type'];
  }
  if (typeof input.hint === 'string') config.hint = input.hint;
  if (typeof input.section === 'string') config.section = input.section;
  if (typeof input.order_index === 'number' && Number.isFinite(input.order_index)) {
    config.order_index = input.order_index;
  }
  const showWhen = input.show_when;
  if (showWhen && typeof showWhen === 'object' && !Array.isArray(showWhen)) {
    const condition = showWhen as Record<string, unknown>;
    if (typeof condition.field_code === 'string' && typeof condition.value === 'string') {
      config.show_when = { field_code: condition.field_code, value: condition.value };
    }
  }
  return config;
}

/** 字段是否适用于当前角色：both 恒适用；角色字段仅对应角色适用；未选角色时只出 both。 */
export function isFieldApplicable(roleScope: RoleScope, role: ActivityRole | ''): boolean {
  return roleScope === 'both' || roleScope === role;
}

/**
 * 由服务端下发的字段构建渲染模型，并按当前角色过滤（role 为空时只保留 both 字段）；
 * 保持服务端返回顺序（排序由服务端按活动配置决定）。
 */
export function buildRegistrationFormModel(
  fields: PublicRegistrationField[],
  role: ActivityRole | '' = '',
): RegistrationFieldModel[] {
  return fields
    .filter((f) => isFieldApplicable(f.role_scope ?? 'both', role))
    .map((f) => ({
      id: f.id,
      fieldCode: f.field_code,
      fieldType: f.field_type,
      label: f.label,
      sourceType: f.source_type,
      isSensitive: f.is_sensitive,
      required: f.required,
      roleScope: f.role_scope ?? 'both',
      config: parseFieldConfig(f.config_json),
      options:
        f.field_type === 'single_choice' || f.field_type === 'multi_choice'
          ? parseChoiceOptions(f.options_json)
          : [],
    }));
}

/** 条件字段仅在其父字段可见且选中指定值时出现。 */
export function isRegistrationFieldVisible(
  model: RegistrationFieldModel,
  models: RegistrationFieldModel[],
  values: RegistrationFormValues,
  seen: Set<string> = new Set(),
): boolean {
  const condition = model.config?.show_when;
  if (!condition) return true;
  if (seen.has(model.id)) return false;
  const parent = models.find((item) => item.fieldCode === condition.field_code);
  if (!parent) return false;
  const parentValue = values[parent.id];
  const matches = Array.isArray(parentValue)
    ? parentValue.includes(condition.value)
    : parentValue === condition.value;
  return matches && isRegistrationFieldVisible(parent, models, values, new Set([...seen, model.id]));
}

export function pruneHiddenRegistrationValues(
  models: RegistrationFieldModel[],
  values: RegistrationFormValues,
): RegistrationFormValues {
  return Object.fromEntries(
    Object.entries(values).filter(([id]) => {
      const model = models.find((item) => item.id === id);
      return model && isRegistrationFieldVisible(model, models, values);
    }),
  );
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** 单字段校验：返回 null 表示通过，否则为错误文案。 */
export function validateFieldValue(
  model: RegistrationFieldModel,
  value: string | string[] | undefined,
): string | null {
  const empty =
    value === undefined ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0);

  if (empty) {
    return model.required ? `请填写「${model.label}」` : null;
  }

  switch (model.fieldType) {
    case 'text':
      if (model.config?.input_type === 'email') {
        return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
          ? null
          : `「${model.label}」邮箱格式不正确`;
      }
      return null;
    case 'number':
      return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))
        ? null
        : `「${model.label}」请输入数字`;
    case 'date':
      return typeof value === 'string' && isValidDateString(value)
        ? null
        : `「${model.label}」日期格式不正确`;
    case 'single_choice': {
      const hit = model.options.some((o) => o.value === value);
      return hit ? null : `「${model.label}」选项无效`;
    }
    case 'multi_choice': {
      if (!Array.isArray(value)) return `「${model.label}」选项无效`;
      const invalid = value.some((v) => !model.options.some((o) => o.value === v));
      return invalid ? `「${model.label}」选项无效` : null;
    }
  }
}

export interface RegistrationValidationResult {
  ok: boolean;
  roleError: string | null;
  fieldErrors: Record<string, string>;
}

/** 整表校验（角色必选 + 逐字段）；仅校验当前角色适用的字段。 */
export function validateRegistrationForm(
  models: RegistrationFieldModel[],
  values: RegistrationFormValues,
  role: ActivityRole | '',
): RegistrationValidationResult {
  const fieldErrors: Record<string, string> = {};
  for (const model of models) {
    if (!isFieldApplicable(model.roleScope, role)) continue;
    if (!isRegistrationFieldVisible(model, models, values)) continue;
    const err = validateFieldValue(model, values[model.id]);
    if (err) fieldErrors[model.id] = err;
  }
  const roleError = role === '' ? '请选择活动角色（倾诉者 / 聆听者）' : null;
  return { ok: roleError === null && Object.keys(fieldErrors).length === 0, roleError, fieldErrors };
}

/**
 * 组装报名提交载荷（POST /api/cc/activities/:id/register 的 answers）。
 * - 传入 role 时仅输出当前角色适用的字段（不适用字段的答案不下发）；
 * - 未作答的非必填字段不下发；
 * - text 去首尾空白；number 转为数值；multi_choice 为标准 JSON 数组（PRD §10.3）。
 */
export function buildRegistrationAnswersPayload(
  models: RegistrationFieldModel[],
  values: RegistrationFormValues,
  role?: ActivityRole | '',
): RegistrationAnswerInput[] {
  const payload: RegistrationAnswerInput[] = [];
  for (const model of models) {
    if (role !== undefined && !isFieldApplicable(model.roleScope, role)) continue;
    if (!isRegistrationFieldVisible(model, models, values)) continue;
    const value = values[model.id];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) payload.push({ field_def_id: model.id, value });
      continue;
    }
    const trimmed = value.trim();
    if (trimmed === '') continue;
    payload.push({
      field_def_id: model.id,
      value: model.fieldType === 'number' ? Number(trimmed) : trimmed,
    });
  }
  return payload;
}
