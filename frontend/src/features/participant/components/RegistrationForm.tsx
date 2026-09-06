import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { normalizeApiError } from '../../../shared/api/http';
import type { ActivityRole, RegistrationRecord } from '../../../shared/api/types';
import { Button, Input } from '../../../shared/ui';
import type { PublicRegistrationField, RegistrationAnswerInput } from '../api';
import {
  buildRegistrationAnswersPayload,
  buildRegistrationFormModel,
  isFieldApplicable,
  validateRegistrationForm,
  type RegistrationFieldModel,
  type RegistrationFormValues,
} from '../lib/registrationForm';
import { activityRoleLabel } from '../lib/status';

/**
 * 报名表单（FR-REG-001/002）：按服务端下发的字段（标准 + 机构自定义）渲染，
 * 选择活动角色（挂在报名上而非账号），敏感字段给出标记提示（security-privacy §4）。
 * 角色名额满时仅禁用该角色选项（FR-ACT-007）；硬校验在服务端事务内。
 * 字段按 role_scope 分角色渲染：both 字段始终显示，角色字段在选定角色后出现，
 * 切换角色时清掉不再适用字段的已填值，提交载荷只含适用字段。
 */

/** 剩余名额（undefined 表示服务端未给出，不展示也不禁用）。 */
export interface RoleRemaining {
  total?: number | null;
  speaker?: number | null;
  listener?: number | null;
}

/** 文本答案长度上限（与服务端校验上限对齐，超出直接无法输入）。 */
const REG_ANSWER_TEXT_MAX = 2000;

/** 仅保留指定 key 的记录项（切换角色时清掉不再适用字段的已填值/校验错误）。 */
function keepKeys<T>(record: Record<string, T>, keys: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => keys.has(k)));
}

function remainingOf(remaining: RoleRemaining, role: ActivityRole): number | null | undefined {
  return role === 'speaker' ? remaining.speaker : remaining.listener;
}

/** 单字段渲染（可访问性：label/legend 关联、错误 role=alert）。 */
function FieldInput({
  model,
  value,
  error,
  onChange,
}: {
  model: RegistrationFieldModel;
  value: string | string[] | undefined;
  error?: string;
  onChange: (value: string | string[]) => void;
}) {
  const sensitiveHint = model.isSensitive ? '敏感信息：仅经授权的范围可见，普通分析不展示' : undefined;

  if (model.fieldType === 'single_choice' || model.fieldType === 'multi_choice') {
    const multi = model.fieldType === 'multi_choice';
    const selected = multi ? (Array.isArray(value) ? value : []) : [];
    return (
      <fieldset
        className={`cc-field cc-fieldset${error ? ' cc-field-error' : ''}`}
        aria-invalid={error ? true : undefined}
      >
        <legend className="cc-label">
          {model.label}
          {model.required ? (
            <span className="cc-required" aria-hidden="true">
              *
            </span>
          ) : null}
        </legend>
        {model.options.length === 0 ? (
          <p className="cc-hint">该字段暂无可选选项，请联系机构管理员</p>
        ) : (
          <div className="cc-choice-list" role="group" aria-label={model.label}>
            {model.options.map((opt) => {
              const id = `f-${model.id}-${opt.value}`;
              const checked = multi ? selected.includes(opt.value) : value === opt.value;
              return (
                <label key={opt.value} className="cc-choice" htmlFor={id}>
                  <input
                    id={id}
                    type={multi ? 'checkbox' : 'radio'}
                    name={`f-${model.id}`}
                    value={opt.value}
                    checked={checked}
                    onChange={(e) => {
                      if (multi) {
                        const next = e.target.checked
                          ? [...selected, opt.value]
                          : selected.filter((v) => v !== opt.value);
                        onChange(next);
                      } else {
                        onChange(opt.value);
                      }
                    }}
                  />
                  <span>{opt.label}</span>
                </label>
              );
            })}
          </div>
        )}
        {sensitiveHint ? <p className="cc-hint cc-hint-sensitive">{sensitiveHint}</p> : null}
        {error ? (
          <p className="cc-error" role="alert">
            {error}
          </p>
        ) : null}
      </fieldset>
    );
  }

  const inputType =
    model.fieldType === 'number' ? 'number' : model.fieldType === 'date' ? 'date' : 'text';
  return (
    <Input
      label={model.label}
      type={inputType}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      required={model.required}
      error={error}
      hint={sensitiveHint}
      maxLength={model.fieldType === 'text' ? REG_ANSWER_TEXT_MAX : undefined}
    />
  );
}

export function RegistrationForm({
  fields,
  remaining,
  submitRegistration,
  onSubmitted,
}: {
  fields: PublicRegistrationField[];
  remaining: RoleRemaining;
  /** 提交动作（由页面注入 API 调用，便于组件测试替换）。 */
  submitRegistration: (input: {
    activity_role: ActivityRole;
    answers: RegistrationAnswerInput[];
  }) => Promise<RegistrationRecord>;
  onSubmitted: (registration: RegistrationRecord) => void;
}) {
  const [role, setRole] = useState<ActivityRole | ''>('');
  // 按当前角色过滤后的适用字段（未选角色时只含 both 字段）
  const models = useMemo(() => buildRegistrationFormModel(fields, role), [fields, role]);
  const [values, setValues] = useState<RegistrationFormValues>({});
  const [roleError, setRoleError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const roles: ActivityRole[] = ['speaker', 'listener'];

  /** 切换角色：清掉不再适用字段的已填值与校验错误，避免隐藏字段随提交带出。 */
  function handleRoleChange(next: ActivityRole) {
    if (next === role) return;
    setRole(next);
    const applicableIds = new Set(
      fields.filter((f) => isFieldApplicable(f.role_scope ?? 'both', next)).map((f) => f.id),
    );
    setValues((prev) => keepKeys(prev, applicableIds));
    setFieldErrors((prev) => keepKeys(prev, applicableIds));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const result = validateRegistrationForm(models, values, role);
    setRoleError(result.roleError ?? undefined);
    setFieldErrors(result.fieldErrors);
    setFormError(undefined);
    if (!result.ok) return;

    setSubmitting(true);
    try {
      const registration = await submitRegistration({
        activity_role: role as ActivityRole,
        answers: buildRegistrationAnswersPayload(models, values, role),
      });
      onSubmitted(registration);
    } catch (err) {
      setFormError(normalizeApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  }

  // both 字段始终显示；角色专属字段（选定角色后才存在）分组显示并附小标题
  const commonModels = models.filter((m) => m.roleScope === 'both');
  const roleModels = models.filter((m) => m.roleScope !== 'both');

  const renderField = (model: RegistrationFieldModel) => (
    <FieldInput
      key={model.id}
      model={model}
      value={values[model.id]}
      error={fieldErrors[model.id]}
      onChange={(v) => setValues((prev) => ({ ...prev, [model.id]: v }))}
    />
  );

  return (
    <form onSubmit={handleSubmit} noValidate>
      <fieldset
        className={`cc-field cc-fieldset${roleError ? ' cc-field-error' : ''}`}
        aria-invalid={roleError ? true : undefined}
      >
        <legend className="cc-label">
          活动角色
          <span className="cc-required" aria-hidden="true">
            *
          </span>
        </legend>
        <div className="cc-choice-list" role="group" aria-label="活动角色">
          {roles.map((r) => {
            const left = remainingOf(remaining, r);
            const full = typeof left === 'number' && left <= 0;
            const id = `role-${r}`;
            return (
              <label key={r} className="cc-choice" htmlFor={id}>
                <input
                  id={id}
                  type="radio"
                  name="activity_role"
                  value={r}
                  checked={role === r}
                  disabled={full}
                  onChange={() => handleRoleChange(r)}
                />
                <span>
                  {activityRoleLabel(r)}
                  {typeof left === 'number' ? (
                    <span className="cc-hint-inline">
                      {full ? '（名额已满）' : `（剩余 ${left} 个名额）`}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
        {roleError ? (
          <p className="cc-error" role="alert">
            {roleError}
          </p>
        ) : null}
      </fieldset>

      {commonModels.map(renderField)}

      {role !== '' && roleModels.length > 0 ? (
        <>
          <p className="cc-group-title">{activityRoleLabel(role)}专属问题</p>
          {roleModels.map(renderField)}
        </>
      ) : null}

      {formError ? (
        <p className="cc-error" role="alert">
          {formError}
        </p>
      ) : null}
      <Button type="submit" block loading={submitting}>
        提交报名
      </Button>
      <p className="cc-hint">提交后进入待审核，不能自行修改或取消（FR-REG-004）。</p>
    <p className="cc-hint">个人信息用途与保存期限见 <a href="/privacy" target="_blank" rel="noopener noreferrer">隐私政策</a>。必要活动通知不代表营销同意。</p>
    </form>
  );
}
