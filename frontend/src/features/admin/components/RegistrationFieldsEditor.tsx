import { useState } from 'react';
import type {
  AdminAccountRecord,
  FieldType,
  RegistrationFieldDefRecord,
  RoleScope,
} from '../../../shared/api/types';
import { adminAuth } from '../../../shared/auth';
import { normalizeApiError } from '../../../shared/api/http';
import { Button, Input, Loading } from '../../../shared/ui';
import { adminCollections } from '../lib/api';
import { FIELD_TYPE_LABELS, ROLE_SCOPE_LABELS, SOURCE_TYPE_LABELS } from '../lib/labels';
import type { ActivityFormFieldConfig } from '../lib/rules';
import { StatusTag } from './StatusTag';

/**
 * 报名表字段配置编辑器（活动创建向导与活动编辑表单共用）。
 *
 * - 标准字段启用/必填 + 机构自定义字段新增（含敏感标记与适用角色，security-privacy §4.2）；
 * - 适用角色（role_scope）决定字段对哪个报名角色出现并参与校验；自定义字段可在此修改，
 *   平台标准字段只读（由超管经集合 API 维护）；
 * - 字段定义加载中/加载失败时调用方必须禁止提交：此时 fieldConfigs 为空数组，提交会用
 *   空配置覆盖既有 form_config_json（数据丢失）。
 */

export interface RegistrationFieldsEditorProps {
  /** null = 加载中。 */
  fieldDefs: RegistrationFieldDefRecord[] | null;
  defsError: string;
  fieldConfigs: ActivityFormFieldConfig[];
  onPatchField: (fieldDefId: string, patch: { enabled?: boolean; required?: boolean }) => void;
  /** 自定义字段创建成功后回调（调用方负责把新字段并入 defs 与 configs）。 */
  onFieldCreated: (def: RegistrationFieldDefRecord) => void;
  /** 字段定义变更回调（适用角色修改的乐观更新/回滚，调用方负责更新 defs）。 */
  onDefChanged: (def: RegistrationFieldDefRecord) => void;
}

/** 选择题选项输入解析：每行一条，格式 `机器值,显示文本` 或仅 `显示文本`（机器值同文本）。 */
function parseOptionsInput(text: string): { options: { value: string; label: string }[] } | undefined {
  const options = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, label] = line.split(/[,，]/).map((s) => s.trim());
      return { value: value || '', label: label || value || '' };
    })
    .filter((o) => o.value !== '');
  return options.length > 0 ? { options } : undefined;
}

/** 生成自定义字段机器码（机构内唯一即可；稳定后不可改，FR-REG-001 同型约束）。 */
function generateCustomFieldCode(): string {
  return `CUS_${Date.now().toString(36).toUpperCase()}`;
}

export function RegistrationFieldsEditor({
  fieldDefs,
  defsError,
  fieldConfigs,
  onPatchField,
  onFieldCreated,
  onDefChanged,
}: RegistrationFieldsEditorProps) {
  const defById = new Map((fieldDefs ?? []).map((d) => [d.id, d]));

  // 自定义字段新增小表单
  const [newLabel, setNewLabel] = useState('');
  const [newType, setNewType] = useState<FieldType>('text');
  const [newSensitive, setNewSensitive] = useState(false);
  const [newRequiredDefault, setNewRequiredDefault] = useState(false);
  const [newOptions, setNewOptions] = useState('');
  const [newRoleScope, setNewRoleScope] = useState<RoleScope>('both');
  const [newFieldError, setNewFieldError] = useState('');
  const [roleScopeError, setRoleScopeError] = useState('');

  const addCustomField = async () => {
    const label = newLabel.trim();
    if (!label) {
      setNewFieldError('请输入字段名称');
      return;
    }
    if ((newType === 'single_choice' || newType === 'multi_choice') && !parseOptionsInput(newOptions)) {
      setNewFieldError('选择题需填写选项（每行一条）');
      return;
    }
    setNewFieldError('');
    const admin = adminAuth.record as AdminAccountRecord | null;
    if (!admin) return;
    try {
      const created = await adminCollections().registrationFieldDefs.create({
        organization_id: admin.organization_id,
        field_code: generateCustomFieldCode(),
        field_type: newType,
        label,
        source_type: 'custom',
        is_sensitive: newSensitive,
        options_json: parseOptionsInput(newOptions),
        required_default: newRequiredDefault,
        role_scope: newRoleScope,
        status: 'active',
      });
      onFieldCreated(created);
      setNewLabel('');
      setNewType('text');
      setNewSensitive(false);
      setNewRequiredDefault(false);
      setNewOptions('');
      setNewRoleScope('both');
    } catch (err) {
      setNewFieldError(normalizeApiError(err).message);
    }
  };

  /** 修改自定义字段的适用角色（仅本机构 custom 字段可改，由服务端 guards 强制；标准字段只读）。 */
  const changeRoleScope = async (def: RegistrationFieldDefRecord, roleScope: RoleScope) => {
    setRoleScopeError('');
    onDefChanged({ ...def, role_scope: roleScope });
    try {
      await adminCollections().registrationFieldDefs.update(def.id, { role_scope: roleScope });
    } catch (err) {
      onDefChanged(def);
      setRoleScopeError(`「${def.label}」适用角色保存失败：${normalizeApiError(err).message}`);
    }
  };

  const isChoiceType = newType === 'single_choice' || newType === 'multi_choice';

  return (
    <fieldset className="admin-section">
      <legend>报名表配置（标准字段启用/必填；自定义字段含敏感标记与适用角色）</legend>
      {defsError ? (
        <p className="cc-error" role="alert">
          字段定义加载失败：{defsError}
        </p>
      ) : null}
      {roleScopeError ? (
        <p className="cc-error" role="alert">
          {roleScopeError}
        </p>
      ) : null}
      {fieldDefs === null && !defsError ? <Loading label="字段定义加载中…" /> : null}
      {fieldConfigs.map((config) => {
        const def = defById.get(config.field_def_id);
        if (!def) return null;
        return (
          <div key={config.field_def_id} className="admin-field-row">
            <span className="admin-field-label">
              {def.label}
              <span className="admin-muted">
                （{SOURCE_TYPE_LABELS[def.source_type]} · {FIELD_TYPE_LABELS[def.field_type]}）
              </span>
            </span>
            {def.is_sensitive ? <StatusTag label="敏感" tone="danger" /> : null}
            {def.source_type === 'custom' ? (
              <select
                className="admin-select"
                aria-label={`${def.label} 适用角色`}
                value={def.role_scope}
                onChange={(e) => void changeRoleScope(def, e.target.value as RoleScope)}
              >
                {Object.entries(ROLE_SCOPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="admin-muted">适用：{ROLE_SCOPE_LABELS[def.role_scope]}</span>
            )}
            <label className="admin-checkbox-row">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => onPatchField(config.field_def_id, { enabled: e.target.checked })}
              />
              启用
            </label>
            <label className="admin-checkbox-row">
              <input
                type="checkbox"
                checked={config.required}
                disabled={!config.enabled}
                onChange={(e) => onPatchField(config.field_def_id, { required: e.target.checked })}
              />
              必填
            </label>
          </div>
        );
      })}

      <div className="admin-section">
        <h3>新增自定义字段</h3>
        <div className="admin-form-grid">
          <Input label="字段名称" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} error={newFieldError} />
          <div className="cc-field">
            <label className="cc-label" htmlFor="new-field-type">
              字段类型
            </label>
            <select
              id="new-field-type"
              className="admin-select"
              value={newType}
              onChange={(e) => setNewType(e.target.value as FieldType)}
            >
              {Object.entries(FIELD_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="cc-field">
            <label className="cc-label" htmlFor="new-field-role-scope">
              适用角色
            </label>
            <select
              id="new-field-role-scope"
              className="admin-select"
              value={newRoleScope}
              onChange={(e) => setNewRoleScope(e.target.value as RoleScope)}
            >
              {Object.entries(ROLE_SCOPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {isChoiceType ? (
          <div className="cc-field">
            <label className="cc-label" htmlFor="new-field-options">
              选项（每行一条，格式：机器值,显示文本 或仅显示文本）
            </label>
            <textarea
              id="new-field-options"
              className="cc-input cc-textarea"
              rows={3}
              value={newOptions}
              onChange={(e) => setNewOptions(e.target.value)}
            />
          </div>
        ) : null}
        <label className="admin-checkbox-row">
          <input
            type="checkbox"
            checked={newSensitive}
            onChange={(e) => setNewSensitive(e.target.checked)}
          />
          标记为敏感字段（普通导出将排除/掩码，FR-EXP-002）
        </label>
        <label className="admin-checkbox-row">
          <input
            type="checkbox"
            checked={newRequiredDefault}
            onChange={(e) => setNewRequiredDefault(e.target.checked)}
          />
          默认必填（活动级可再调整）
        </label>
        <Button variant="secondary" onClick={addCustomField}>
          添加字段
        </Button>
      </div>
    </fieldset>
  );
}
