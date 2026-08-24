import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  ActivityRecord,
  FieldType,
  RegistrationFieldDefRecord,
  RoleScope,
} from '../../../shared/api/types';
import { adminAuth } from '../../../shared/auth';
import { normalizeApiError } from '../../../shared/api/http';
import type { AdminAccountRecord } from '../../../shared/api/types';
import { Button, Input, Loading } from '../../../shared/ui';
import { FIELD_TYPE_LABELS, ROLE_SCOPE_LABELS, SOURCE_TYPE_LABELS } from '../lib/labels';
import { fromInputDateTime, toInputDateTime } from '../lib/format';
import {
  mergeFormConfig,
  parseFormConfig,
  setFormFieldConfig,
  validateCapacityEdit,
  type ActivityFormFieldConfig,
  type ApprovedCounts,
  type CapacityEditErrors,
} from '../lib/rules';
import { adminCollections } from '../lib/api';
import { StatusTag } from './StatusTag';

/**
 * 活动创建/编辑表单（FR-ACT-001/005/006）。
 *
 * - 创建走 activities 集合 API（createRule 限定本机构）；必需的 checkin_qr_token
 *   由服务端生成（防伪造/防覆盖），创建/详情响应带回，前端不生成；初始状态固定 draft。
 * - 名额只填总名额（正偶数），倾诉者/聆听者名额由总名额对半派生；
 *   编辑时按 FR-ACT-006 做「不得低于当前已通过人数」的前端提示（服务端 hooks 硬校验兜底）。
 * - 报名表配置：标准字段启用/必填 + 机构自定义字段新增（含敏感标记与适用角色，
 *   security-privacy §4.2）；适用角色（role_scope）决定字段对哪个报名角色出现并参与校验，
 *   自定义字段可在此修改，平台标准字段只读（由超管经集合 API 维护）。
 *   配置存 activities.form_config_json（database-design D-3），结构见 lib/rules.parseFormConfig。
 *   字段定义加载中/加载失败时禁止提交：此时 fieldConfigs 为空数组，提交会用空配置
 *   覆盖既有 form_config_json（数据丢失）。
 * - group_tag 为预留分组字段（PRD §4.1：V1 不消费，仅录入保留）。
 */

export interface ActivityFormProps {
  mode: 'create' | 'edit';
  /** 编辑模式的活动记录。 */
  initial?: ActivityRecord;
  /** 当前已通过人数（编辑模式下名额下限校验用；创建传零值）。 */
  approvedCounts: ApprovedCounts;
  onSaved: (activity: ActivityRecord) => void;
  onCancel?: () => void;
}

const ZERO_COUNTS: ApprovedCounts = { total: 0, speaker: 0, listener: 0 };

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

export function ActivityForm({ mode, initial, approvedCounts, onSaved, onCancel }: ActivityFormProps) {
  const counts = mode === 'edit' ? approvedCounts : ZERO_COUNTS;

  const [title, setTitle] = useState(initial?.title ?? '');
  const [activityCode, setActivityCode] = useState(initial?.activity_code ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [startTime, setStartTime] = useState(toInputDateTime(initial?.start_time));
  const [endTime, setEndTime] = useState(toInputDateTime(initial?.end_time));
  const [capacityTotal, setCapacityTotal] = useState(String(initial?.capacity_total ?? ''));
  const [registrationOpen, setRegistrationOpen] = useState(initial?.registration_open ?? true);
  const [regStart, setRegStart] = useState(toInputDateTime(initial?.registration_start_at));
  const [regEnd, setRegEnd] = useState(toInputDateTime(initial?.registration_end_at));
  const [groupTag, setGroupTag] = useState(initial?.group_tag ?? '');

  const [fieldDefs, setFieldDefs] = useState<RegistrationFieldDefRecord[] | null>(null);
  const [fieldConfigs, setFieldConfigs] = useState<ActivityFormFieldConfig[]>([]);
  const [defsError, setDefsError] = useState('');

  // 自定义字段新增小表单
  const [newLabel, setNewLabel] = useState('');
  const [newType, setNewType] = useState<FieldType>('text');
  const [newSensitive, setNewSensitive] = useState(false);
  const [newRequiredDefault, setNewRequiredDefault] = useState(false);
  const [newOptions, setNewOptions] = useState('');
  const [newRoleScope, setNewRoleScope] = useState<RoleScope>('both');
  const [roleScopeError, setRoleScopeError] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 加载字段定义（标准 + 本机构自定义；机构隔离由服务端规则保证）
  useEffect(() => {
    let cancelled = false;
    adminCollections()
      .registrationFieldDefs.getFullList({ filter: 'status = "active"', sort: 'created' })
      .then((defs) => {
        if (cancelled) return;
        const ordered = [
          ...defs.filter((d) => d.source_type === 'standard'),
          ...defs.filter((d) => d.source_type === 'custom'),
        ];
        setFieldDefs(ordered);
        setFieldConfigs(
          mergeFormConfig(
            ordered.map((d) => ({ id: d.id, required_default: d.required_default })),
            parseFormConfig(initial?.form_config_json),
          ),
        );
      })
      .catch((err) => {
        if (!cancelled) setDefsError(normalizeApiError(err).message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const defById = useMemo(
    () => new Map((fieldDefs ?? []).map((d) => [d.id, d])),
    [fieldDefs],
  );

  const patchField = (fieldDefId: string, patch: { enabled?: boolean; required?: boolean }) => {
    setFieldConfigs((prev) => setFormFieldConfig(prev, fieldDefId, patch));
  };

  const addCustomField = async () => {
    const label = newLabel.trim();
    if (!label) {
      setErrors((prev) => ({ ...prev, new_field_label: '请输入字段名称' }));
      return;
    }
    if ((newType === 'single_choice' || newType === 'multi_choice') && !parseOptionsInput(newOptions)) {
      setErrors((prev) => ({ ...prev, new_field_label: '选择题需填写选项（每行一条）' }));
      return;
    }
    setErrors((prev) => ({ ...prev, new_field_label: '' }));
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
      setFieldDefs((prev) => [...(prev ?? []), created]);
      setFieldConfigs((prev) => [
        ...prev,
        { field_def_id: created.id, enabled: true, required: newRequiredDefault },
      ]);
      setNewLabel('');
      setNewType('text');
      setNewSensitive(false);
      setNewRequiredDefault(false);
      setNewOptions('');
      setNewRoleScope('both');
    } catch (err) {
      setErrors((prev) => ({ ...prev, new_field_label: normalizeApiError(err).message }));
    }
  };

  /** 修改自定义字段的适用角色（仅本机构 custom 字段可改，由服务端 guards 强制；标准字段只读）。 */
  const changeRoleScope = async (def: RegistrationFieldDefRecord, roleScope: RoleScope) => {
    setRoleScopeError('');
    const prevScope = def.role_scope;
    setFieldDefs((prev) =>
      (prev ?? []).map((d) => (d.id === def.id ? { ...d, role_scope: roleScope } : d)),
    );
    try {
      await adminCollections().registrationFieldDefs.update(def.id, { role_scope: roleScope });
    } catch (err) {
      setFieldDefs((prev) =>
        (prev ?? []).map((d) => (d.id === def.id ? { ...d, role_scope: prevScope } : d)),
      );
      setRoleScopeError(`「${def.label}」适用角色保存失败：${normalizeApiError(err).message}`);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError('');
    // 字段定义未就绪时禁止提交：fieldConfigs 为空数组会覆盖既有 form_config_json
    if (!defsReady) return;
    const nextErrors: Record<string, string> = {};

    if (!title.trim()) nextErrors.title = '请输入活动标题';
    if (mode === 'create' && !activityCode.trim()) {
      nextErrors.activity_code = '请输入活动代码（如 CC_SG_202608_01）';
    }
    const start = fromInputDateTime(startTime);
    const end = fromInputDateTime(endTime);
    if (!start) nextErrors.start_time = '请选择开始时间';
    if (!end) nextErrors.end_time = '请选择结束时间';
    if (start && end && start >= end) nextErrors.end_time = '结束时间须晚于开始时间';
    const regStartIso = fromInputDateTime(regStart);
    const regEndIso = fromInputDateTime(regEnd);
    if (regStart && !regStartIso) nextErrors.registration_start_at = '报名开始时间格式不正确';
    if (regEnd && !regEndIso) nextErrors.registration_end_at = '报名结束时间格式不正确';
    if (regStartIso && regEndIso && regStartIso >= regEndIso) {
      nextErrors.registration_end_at = '报名结束须晚于报名开始';
    }

    const total = Number(capacityTotal);
    const capacityErrors: CapacityEditErrors = validateCapacityEdit(total, counts);
    Object.assign(nextErrors, capacityErrors);

    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;

    setSubmitting(true);
    try {
      const cc = adminCollections();
      const payload: Record<string, unknown> = {
        title: title.trim(),
        description: description.trim() || undefined,
        location: location.trim() || undefined,
        start_time: start,
        end_time: end,
        // 校验已通过（正偶数），角色名额按总名额对半派生
        capacity_total: total,
        capacity_speaker: total / 2,
        capacity_listener: total / 2,
        registration_open: registrationOpen,
        registration_start_at: regStartIso,
        registration_end_at: regEndIso,
        group_tag: groupTag.trim() || undefined,
        form_config_json: { fields: fieldConfigs },
      };
      let saved: ActivityRecord;
      if (mode === 'create') {
        const admin = adminAuth.record as AdminAccountRecord | null;
        saved = await cc.activities.create({
          ...payload,
          organization_id: admin?.organization_id,
          activity_code: activityCode.trim(),
          status: 'draft',
        });
      } else {
        saved = await cc.activities.update(initial!.id, payload);
      }
      onSaved(saved);
    } catch (err) {
      setSubmitError(normalizeApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  const isChoiceType = newType === 'single_choice' || newType === 'multi_choice';

  // 字段定义加载中（null）或加载失败（defsError 非空）时未就绪：
  // 此时提交会以空 fieldConfigs 覆盖既有 form_config_json，必须阻止
  const defsReady = fieldDefs !== null && defsError === '';

  // 总名额提示：合法正偶数时展示对半结果；编辑模式附带已通过人数
  const parsedTotal = Number(capacityTotal);
  const splitHint =
    Number.isInteger(parsedTotal) && parsedTotal > 0 && parsedTotal % 2 === 0
      ? `倾诉者/聆听者名额自动对半分配（各 ${parsedTotal / 2} 人）`
      : '总名额须为正偶数，倾诉者/聆听者名额自动对半分配';
  const approvedHint =
    counts.total > 0
      ? `当前已通过 ${counts.total} 人（倾诉者 ${counts.speaker} / 聆听者 ${counts.listener}）`
      : '';
  const capacityHint = [splitHint, approvedHint].filter(Boolean).join('；');

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="admin-form-grid">
        <Input label="活动标题" value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} required />
        <Input
          label="活动代码"
          value={activityCode}
          onChange={(e) => setActivityCode(e.target.value)}
          error={errors.activity_code}
          hint={mode === 'edit' ? '活动代码创建后不可修改（保持稳定）' : '如 CC_SG_202608_01，全局唯一'}
          disabled={mode === 'edit'}
          required
        />
        <Input
          label="开始时间"
          type="datetime-local"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          error={errors.start_time}
          required
        />
        <Input
          label="结束时间"
          type="datetime-local"
          value={endTime}
          onChange={(e) => setEndTime(e.target.value)}
          error={errors.end_time}
          required
        />
        <Input label="地点" value={location} onChange={(e) => setLocation(e.target.value)} />
        <Input
          label="分组标签（预留）"
          value={groupTag}
          onChange={(e) => setGroupTag(e.target.value)}
          hint="预留字段（PRD §4.1），V1 不生效，仅随数据保留"
        />
        <Input
          label="总名额"
          type="number"
          min={2}
          step={2}
          value={capacityTotal}
          onChange={(e) => setCapacityTotal(e.target.value)}
          error={errors.capacity_total}
          hint={capacityHint}
          required
        />
        <Input
          label="报名开始时间"
          type="datetime-local"
          value={regStart}
          onChange={(e) => setRegStart(e.target.value)}
          error={errors.registration_start_at}
        />
        <Input
          label="报名结束时间"
          type="datetime-local"
          value={regEnd}
          onChange={(e) => setRegEnd(e.target.value)}
          error={errors.registration_end_at}
          hint="留空表示不限时间；超时后不能新提交（FR-ACT-005）"
        />
      </div>

      <label className="admin-checkbox-row admin-section">
        <input
          type="checkbox"
          checked={registrationOpen}
          onChange={(e) => setRegistrationOpen(e.target.checked)}
        />
        开放报名（手动开关，FR-ACT-005）
      </label>

      <div className="admin-section">
        <Input
          label="活动描述"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          hint="展示在公开活动详情页"
        />
      </div>

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
                  onChange={(e) => patchField(config.field_def_id, { enabled: e.target.checked })}
                />
                启用
              </label>
              <label className="admin-checkbox-row">
                <input
                  type="checkbox"
                  checked={config.required}
                  disabled={!config.enabled}
                  onChange={(e) => patchField(config.field_def_id, { required: e.target.checked })}
                />
                必填
              </label>
            </div>
          );
        })}

        <div className="admin-section">
          <h3>新增自定义字段</h3>
          <div className="admin-form-grid">
            <Input label="字段名称" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} error={errors.new_field_label} />
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

      {submitError ? (
        <p className="cc-error" role="alert">
          {submitError}
        </p>
      ) : null}
      {!defsReady ? (
        <p className="cc-hint" role="note">
          {defsError
            ? '报名字段定义加载失败，暂不能提交（避免空配置覆盖既有报名表）；请关闭后重试。'
            : '报名字段定义加载中，加载完成后才能提交（避免空配置覆盖既有报名表）。'}
        </p>
      ) : null}
      <div className="admin-row-actions admin-section">
        <Button type="submit" loading={submitting} disabled={!defsReady}>
          {mode === 'create' ? '创建活动' : '保存修改'}
        </Button>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel} disabled={submitting}>
            取消
          </Button>
        ) : null}
      </div>
    </form>
  );
}
