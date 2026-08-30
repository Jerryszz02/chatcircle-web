import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  ActivityRecord,
  RegistrationFieldDefRecord,
} from '../../../shared/api/types';
import { adminAuth } from '../../../shared/auth';
import { normalizeApiError } from '../../../shared/api/http';
import type { AdminAccountRecord } from '../../../shared/api/types';
import { Button, Input } from '../../../shared/ui';
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
import { RegistrationFieldsEditor } from './RegistrationFieldsEditor';

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

  const patchField = (fieldDefId: string, patch: { enabled?: boolean; required?: boolean }) => {
    setFieldConfigs((prev) => setFormFieldConfig(prev, fieldDefId, patch));
  };

  /** 自定义字段创建成功：并入定义列表与表单配置（默认启用、采用其默认必填）。 */
  const handleFieldCreated = (created: RegistrationFieldDefRecord) => {
    setFieldDefs((prev) => [...(prev ?? []), created]);
    setFieldConfigs((prev) => [
      ...prev,
      { field_def_id: created.id, enabled: true, required: created.required_default },
    ]);
  };

  /** 字段定义变更（适用角色乐观更新/回滚由编辑器发起）。 */
  const handleDefChanged = (def: RegistrationFieldDefRecord) => {
    setFieldDefs((prev) => (prev ?? []).map((d) => (d.id === def.id ? def : d)));
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

      <RegistrationFieldsEditor
        fieldDefs={fieldDefs}
        defsError={defsError}
        fieldConfigs={fieldConfigs}
        onPatchField={patchField}
        onFieldCreated={handleFieldCreated}
        onDefChanged={handleDefChanged}
      />

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
