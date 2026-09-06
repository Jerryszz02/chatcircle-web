import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type {
  ActivityRecord,
  AdminAccountRecord,
  OrganizationRecord,
  RegistrationFieldDefRecord,
  RoleScope,
  SurveyTemplateRecord,
} from '../../../shared/api/types';
import { adminAuth } from '../../../shared/auth';
import { normalizeApiError } from '../../../shared/api/http';
import { Button, Card, Input, Loading } from '../../../shared/ui';
import { RegistrationFieldsEditor } from '../components/RegistrationFieldsEditor';
import { adminCollections, duplicateActivity, createActivitySurvey, runActivityAction } from '../lib/api';
import { fromInputDateTime, formatDateTime } from '../lib/format';
import { FIELD_TYPE_LABELS, ROLE_SCOPE_LABELS } from '../lib/labels';
import { mergeFormConfig, parseFormConfig, setFormFieldConfig, type ActivityFormFieldConfig } from '../lib/rules';
import {
  findMissingItems,
  validateWizardBasics,
  validateWizardRegistration,
  type WizardBasicsErrors,
  type WizardRegistrationErrors,
} from '../lib/workbench';

/**
 * 活动创建分步向导（PRD §4.1：基本信息 → 角色与报名 → 现场设置 → 问卷 → 预览与发布）。
 *
 * - 创建仍走 activities 集合 API（createRule 限定本机构；checkin_qr_token 由服务端
 *   生成，初始状态固定 draft），与 ActivityForm 的创建路径一致；
 * - 「现场设置」保存预计签到时间和配对开关；预计时间为提示，实际开放仍手动；
 * - 「问卷」步勾选的模板在草稿创建成功后逐个复制为活动问卷（draft 状态），
 *   部分失败不阻塞活动创建，结果在完成页展示；
 * - 预览步同时展示参与者端活动详情与报名表效果、缺失项与下一步（PRD §4.1 第 5 步）。
 */

type WizardStep = 'basics' | 'registration' | 'onsite' | 'surveys' | 'preview';

const STEPS: Array<{ key: WizardStep; label: string }> = [
  { key: 'basics', label: '基本信息' },
  { key: 'registration', label: '角色与报名' },
  { key: 'onsite', label: '现场设置' },
  { key: 'surveys', label: '问卷' },
  { key: 'preview', label: '预览与发布' },
];

interface SurveyPick {
  templateId: string;
  title: string;
  roleScope: RoleScope;
  phase: 'before' | 'onsite' | 'after';
  plannedOpen: string;
}

export function ActivityCreateWizard() {
  const navigate = useNavigate();
  const [activityTemplates, setActivityTemplates] = useState<ActivityRecord[]>([]);
  const [templateError, setTemplateError] = useState('');
  const [templateBusy, setTemplateBusy] = useState(false);
  const [step, setStep] = useState<WizardStep>('basics');

  // 基本信息
  const [title, setTitle] = useState('');
  const [activityCode, setActivityCode] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [capacityTotal, setCapacityTotal] = useState('');
  const [groupTag, setGroupTag] = useState('');

  // 角色与报名
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [regStart, setRegStart] = useState('');
  const [regEnd, setRegEnd] = useState('');
  const [fieldDefs, setFieldDefs] = useState<RegistrationFieldDefRecord[] | null>(null);
  const [fieldConfigs, setFieldConfigs] = useState<ActivityFormFieldConfig[]>([]);
  const [defsError, setDefsError] = useState('');

  const [pairingEnabled, setPairingEnabled] = useState(true);
  const [plannedCheckin, setPlannedCheckin] = useState('');
  const [onsiteError, setOnsiteError] = useState('');

  // 问卷
  const [templates, setTemplates] = useState<SurveyTemplateRecord[] | null>(null);
  const [templatesError, setTemplatesError] = useState('');
  const [surveyPicks, setSurveyPicks] = useState<SurveyPick[]>([]);

  // 预览与发布
  const [org, setOrg] = useState<OrganizationRecord | null>(null);
  const [basicsErrors, setBasicsErrors] = useState<WizardBasicsErrors>({});
  const [regErrors, setRegErrors] = useState<WizardRegistrationErrors>({});
  const [previewRole, setPreviewRole] = useState<'speaker' | 'listener'>('speaker');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [created, setCreated] = useState<ActivityRecord | null>(null);
  const [surveyResults, setSurveyResults] = useState<Array<{ title: string; ok: boolean; error?: string }>>([]);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState('');

  // 加载字段定义 / 问卷模板 / 机构开关（发布动作按 require_activity_approval 分流）
  useEffect(() => {
    let cancelled = false;
    const cc = adminCollections();
    cc.activities
      .getFullList({ filter: 'is_template = true && status = "draft"', sort: '-created' })
      .then((list) => {
        if (!cancelled) setActivityTemplates(list);
      })
      .catch(() => {
        if (!cancelled) setTemplateError('机构模板加载失败，可以继续手动创建或刷新页面重试。');
      });
    cc.registrationFieldDefs
      .getFullList({ filter: 'status = "active"', sort: 'created' })
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
            parseFormConfig(undefined),
          ),
        );
      })
      .catch((err) => {
        if (!cancelled) setDefsError(normalizeApiError(err).message);
      });
    cc.surveyTemplates
      .getFullList({ filter: 'status = "active"' })
      .then((list) => {
        if (!cancelled) setTemplates(list);
      })
      .catch((err) => {
        if (!cancelled) setTemplatesError(normalizeApiError(err).message);
      });
    const admin = adminAuth.record as AdminAccountRecord | null;
    if (admin?.organization_id) {
      cc.organizations
        .getOne(admin.organization_id)
        .then((record) => {
          if (!cancelled) setOrg(record);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const defsReady = fieldDefs !== null && defsError === '';

  const fullNameReady = useMemo(() => {
    const def = (fieldDefs ?? []).find((d) => d.field_code === 'FULL_NAME');
    if (!def) return null;
    const cfg = fieldConfigs.find((c) => c.field_def_id === def.id);
    return !!cfg && cfg.enabled && cfg.required;
  }, [fieldDefs, fieldConfigs]);

  const missingItems = useMemo(() => {
    const start = fromInputDateTime(startTime);
    const end = fromInputDateTime(endTime);
    const capacity = Number(capacityTotal);
    return findMissingItems({
      title,
      activityCode,
      description,
      location,
      timeRangeValid: !!start && !!end && start < end,
      capacityValid: Number.isInteger(capacity) && capacity > 0 && capacity % 2 === 0,
      enabledFieldCount: fieldConfigs.filter((c) => c.enabled).length,
      fullNameReady,
      surveyCount: surveyPicks.length,
    });
  }, [
    title,
    activityCode,
    description,
    location,
    startTime,
    endTime,
    capacityTotal,
    fieldConfigs,
    fullNameReady,
    surveyPicks,
  ]);

  const validateOnsite = () => {
    const invalid = plannedCheckin && (fromInputDateTime(plannedCheckin) ?? '') > (fromInputDateTime(endTime) ?? '');
    setOnsiteError(invalid ? '预计签到开放时间不得晚于活动结束' : '');
    return !invalid;
  };

  /** 离开基本信息步前校验；不通过则停留并内联展示错误。 */
  const goNext = () => {
    if (step === 'basics') {
      const errors = validateWizardBasics({ title, activityCode, startTime, endTime, capacityTotal });
      setBasicsErrors(errors);
      if (Object.values(errors).some(Boolean)) return;
    }
    if (step === 'registration') {
      const errors = validateWizardRegistration({ regStart, regEnd });
      setRegErrors(errors);
      if (Object.values(errors).some(Boolean)) return;
    }
    if (step === 'onsite' && !validateOnsite()) return;
    const next = STEPS[stepIndex + 1];
    if (next) setStep(next.key);
  };

  const goPrev = () => {
    const prev = STEPS[stepIndex - 1];
    if (prev) setStep(prev.key);
  };

  const toggleSurveyPick = (template: SurveyTemplateRecord) => {
    setSurveyPicks((prev) => {
      const existing = prev.find((p) => p.templateId === template.id);
      if (existing) return prev.filter((p) => p.templateId !== template.id);
      return [
        ...prev,
        { templateId: template.id, title: template.name, roleScope: 'both', phase: 'onsite', plannedOpen: '' },
      ];
    });
  };

  const patchSurveyPick = (templateId: string, patch: Partial<SurveyPick>) => {
    setSurveyPicks((prev) => prev.map((p) => (p.templateId === templateId ? { ...p, ...patch } : p)));
  };

  /** 创建草稿并逐个复制勾选问卷；问卷失败不阻塞（记录在完成页）。 */
  const submitCreate = async () => {
    const errors = validateWizardBasics({ title, activityCode, startTime, endTime, capacityTotal });
    setBasicsErrors(errors);
    const regWindowErrors = validateWizardRegistration({ regStart, regEnd });
    setRegErrors(regWindowErrors);
    if (Object.values(errors).some(Boolean)) {
      setStep('basics');
      return;
    }
    if (Object.values(regWindowErrors).some(Boolean)) {
      setStep('registration');
      return;
    }
    if (!validateOnsite()) {
      setStep('onsite');
      return;
    }
    if (!defsReady) {
      setStep('basics');
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      const admin = adminAuth.record as AdminAccountRecord | null;
      const total = Number(capacityTotal);
      const activity = await adminCollections().activities.create({
        organization_id: admin?.organization_id,
        activity_code: activityCode.trim(),
        title: title.trim(),
        description: description.trim() || undefined,
        location: location.trim() || undefined,
        start_time: fromInputDateTime(startTime),
        end_time: fromInputDateTime(endTime),
        status: 'draft',
        capacity_total: total,
        capacity_speaker: total / 2,
        capacity_listener: total / 2,
        pairing_enabled: pairingEnabled,
        planned_checkin_at: fromInputDateTime(plannedCheckin),
        registration_open: registrationOpen,
        registration_start_at: fromInputDateTime(regStart),
        registration_end_at: fromInputDateTime(regEnd),
        group_tag: groupTag.trim() || undefined,
        form_config_json: { fields: fieldConfigs },
      });
      const results: Array<{ title: string; ok: boolean; error?: string }> = [];
      for (const pick of surveyPicks) {
        const template = (templates ?? []).find((t) => t.id === pick.templateId);
        if (!template) {
          results.push({ title: pick.title, ok: false, error: '模板不存在或已停用' });
          continue;
        }
        try {
          await createActivitySurvey(activity.id, {
            template_version_id: template.current_version_id,
            title: pick.title.trim() || template.name,
            role_scope: pick.roleScope,
            phase: pick.phase,
            planned_open_at: fromInputDateTime(pick.plannedOpen),
          });
          results.push({ title: pick.title, ok: true });
        } catch (err) {
          results.push({ title: pick.title, ok: false, error: normalizeApiError(err).message });
        }
      }
      setSurveyResults(results);
      setCreated(activity);
    } catch (err) {
      setSubmitError(normalizeApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  /** 创建后发布动作：机构开启发布审核时提交平台审核，否则直接发布（FR-ORG-004）。 */
  const publishCreated = async () => {
    if (!created) return;
    setPublishing(true);
    setPublishError('');
    try {
      await runActivityAction(created.id, org?.require_activity_approval ? 'submit-review' : 'publish');
      navigate(`/admin/activities/${created.id}`);
    } catch (err) {
      setPublishError(normalizeApiError(err).message);
    } finally {
      setPublishing(false);
    }
  };

  /** 报名表预览字段：启用且适用于当前预览角色。 */
  const previewFields = fieldConfigs
    .filter((c) => c.enabled)
    .map((c) => ({ config: c, def: (fieldDefs ?? []).find((d) => d.id === c.field_def_id) }))
    .filter((row): row is { config: ActivityFormFieldConfig; def: RegistrationFieldDefRecord } => !!row.def)
    .filter((row) => row.def.role_scope === 'both' || row.def.role_scope === previewRole);

  const parsedCapacity = Number(capacityTotal);
  const capacityHint =
    Number.isInteger(parsedCapacity) && parsedCapacity > 0 && parsedCapacity % 2 === 0
      ? `倾诉者/聆听者名额自动对半分配（各 ${parsedCapacity / 2} 人）`
      : '总名额须为正偶数，倾诉者/聆听者名额自动对半分配';

  return (
    <div>
      <ol className="admin-steps" aria-label="创建步骤">
        {STEPS.map((s, index) => (
          <li
            key={s.key}
            className={`admin-step${s.key === step ? ' admin-step-active' : ''}${index < stepIndex ? ' admin-step-done' : ''}`}
            aria-current={s.key === step ? 'step' : undefined}
          >
            {index + 1}. {s.label}
          </li>
        ))}
      </ol>

      {step === 'basics' ? (
        <Card title="从机构模板创建" className="admin-section">
          <p className="admin-muted">使用已保存的配置和问卷新建草稿，再调整日期和报名窗口；不会带入历史人员数据。</p>
          {templateError ? <p role="alert">{templateError}</p> : null}
          {activityTemplates.length === 0 ? (
            <p>暂无机构模板。可在活动列表将已有活动另存为模板。</p>
          ) : (
            activityTemplates.map((template) => (
              <Button
                key={template.id}
                variant="secondary"
                loading={templateBusy}
                onClick={async () => {
                  setTemplateBusy(true);
                  setTemplateError('');
                  try {
                    const result = await duplicateActivity(template.id);
                    navigate(`/admin/activities/${result.activity.id}`);
                  } catch (err) {
                    setTemplateError(normalizeApiError(err).message);
                  } finally {
                    setTemplateBusy(false);
                  }
                }}
              >
                {template.title}
              </Button>
            ))
          )}
        </Card>
      ) : null}
      {step === 'basics' ? (
        <Card title="基本信息" className="admin-section">
          <div className="admin-form-grid">
            <Input
              label="活动标题"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              error={basicsErrors.title}
              required
            />
            <Input
              label="活动代码"
              value={activityCode}
              onChange={(e) => setActivityCode(e.target.value)}
              error={basicsErrors.activity_code}
              hint="如 CC_SG_202608_01，全局唯一；创建后不可修改"
              required
            />
            <Input
              label="开始时间"
              type="datetime-local"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              error={basicsErrors.start_time}
              required
            />
            <Input
              label="结束时间"
              type="datetime-local"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              error={basicsErrors.end_time}
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
              error={basicsErrors.capacity_total}
              hint={capacityHint}
              required
            />
          </div>
          <div className="admin-section">
            <Input
              label="活动介绍"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              hint="展示在公开活动详情页"
            />
          </div>
        </Card>
      ) : null}

      {step === 'registration' ? (
        <Card title="角色与报名" className="admin-section">
          <p className="admin-muted">
            活动内角色为倾诉者/聆听者，名额由总名额对半派生（FR-REG-002、FR-ACT-006）。
            报名时间留空表示不限；超时后不能新提交（FR-ACT-005）。
          </p>
          <div className="admin-form-grid">
            <Input
              label="报名开始时间"
              type="datetime-local"
              value={regStart}
              onChange={(e) => setRegStart(e.target.value)}
              error={regErrors.registration_start_at}
            />
            <Input
              label="报名结束时间"
              type="datetime-local"
              value={regEnd}
              onChange={(e) => setRegEnd(e.target.value)}
              error={regErrors.registration_end_at}
            />
          </div>
          <label className="admin-checkbox-row admin-section">
            <input type="checkbox" checked={registrationOpen} onChange={(e) => setRegistrationOpen(e.target.checked)} />
            开放报名（手动开关，FR-ACT-005）
          </label>
          <RegistrationFieldsEditor
            fieldDefs={fieldDefs}
            defsError={defsError}
            fieldConfigs={fieldConfigs}
            onPatchField={(id, patch) => setFieldConfigs((prev) => setFormFieldConfig(prev, id, patch))}
            onFieldCreated={(createdDef) => {
              setFieldDefs((prev) => [...(prev ?? []), createdDef]);
              setFieldConfigs((prev) => [
                ...prev,
                { field_def_id: createdDef.id, enabled: true, required: createdDef.required_default },
              ]);
            }}
            onDefChanged={(def) => setFieldDefs((prev) => (prev ?? []).map((d) => (d.id === def.id ? def : d)))}
          />
        </Card>
      ) : null}

      {step === 'onsite' ? (
        <Card title="现场设置" className="admin-section">
          <p className="admin-muted">预计时间用于筹备提示，实际开放签到和开始配对仍由管理员手动控制。</p>
          <Input
            label="预计签到开放时间"
            type="datetime-local"
            value={plannedCheckin}
            onChange={(e) => setPlannedCheckin(e.target.value)}
            error={onsiteError}
          />
          <label className="admin-checkbox-row">
            <input type="checkbox" checked={pairingEnabled} onChange={(e) => setPairingEnabled(e.target.checked)} />
            启用现场配对
          </label>
          <ul className="admin-note-list">
            <li>签到方式：固定二维码（FR-CHK-001），创建后由服务端生成，活动现场在详情页「签到管理」开放/关闭。</li>
            <li>
              现场编号：签到成功即按角色分配现场序号（倾诉者 S01…/聆听者 L01…），号码发出后不复用（专项 PRD §5.1）。
            </li>
            <li>
              现场配对：配对由管理员在现场工作台点击「开始配对」触发，按现场序号依次配对（专项 PRD
              §5.2）；关闭本场配对后不能启动配对。
            </li>
            <li>现场工作台：活动详情页「现场工作台」实时集中展示报名、签到、配对与问卷完成情况（专项 PRD §4.3）。</li>
          </ul>
        </Card>
      ) : null}

      {step === 'surveys' ? (
        <Card title="问卷" className="admin-section">
          <p className="admin-muted">
            从模板添加活动问卷（复制模板当前版本，创建后可在详情页继续调整题目与开放时机，FR-SUR-011）。
            开放/结束由管理员在活动现场手动控制（PRD §8.2）。
          </p>
          {templatesError ? (
            <p className="cc-error" role="alert">
              模板加载失败：{templatesError}
            </p>
          ) : null}
          {templates === null && !templatesError ? <Loading label="模板加载中…" /> : null}
          {templates !== null && templates.length === 0 && !templatesError ? (
            <p className="admin-empty">暂无可用问卷模板，可跳过本步，创建后再添加。</p>
          ) : null}
          {(templates ?? []).map((template) => {
            const pick = surveyPicks.find((p) => p.templateId === template.id);
            return (
              <div key={template.id} className="admin-field-row">
                <label className="admin-checkbox-row">
                  <input type="checkbox" checked={!!pick} onChange={() => toggleSurveyPick(template)} />
                  {template.name}
                  <span className="admin-muted">（{template.template_code}）</span>
                </label>
                {pick ? (
                  <>
                    <input
                      className="cc-input"
                      aria-label={`${template.name} 问卷标题`}
                      value={pick.title}
                      onChange={(e) => patchSurveyPick(template.id, { title: e.target.value })}
                    />
                    <select
                      className="admin-select"
                      aria-label={`${template.name} 适用角色`}
                      value={pick.roleScope}
                      onChange={(e) => patchSurveyPick(template.id, { roleScope: e.target.value as RoleScope })}
                    >
                      {Object.entries(ROLE_SCOPE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <select
                      className="admin-select"
                      aria-label={`${template.name} 问卷阶段`}
                      value={pick.phase}
                      onChange={(e) => patchSurveyPick(template.id, { phase: e.target.value as SurveyPick['phase'] })}
                    >
                      <option value="before">活动前</option>
                      <option value="onsite">现场</option>
                      <option value="after">活动后</option>
                    </select>
                    <Input
                      label={`${template.name} 预计开放时间`}
                      type="datetime-local"
                      value={pick.plannedOpen}
                      onChange={(e) => patchSurveyPick(template.id, { plannedOpen: e.target.value })}
                    />
                  </>
                ) : null}
              </div>
            );
          })}
        </Card>
      ) : null}

      {step === 'preview' ? (
        <div className="admin-section">
          {created ? (
            <Card title="活动已创建">
              <p>
                草稿已创建：{created.title}（代码 <code>{created.activity_code}</code>）。 签到二维码 token
                由服务端生成，历史数据不会从其他活动带入。
              </p>
              {surveyResults.length > 0 ? (
                <ul className="admin-note-list">
                  {surveyResults.map((r) => (
                    <li key={r.title}>
                      问卷「{r.title}」{r.ok ? '已创建（草稿）' : `创建失败：${r.error ?? '未知错误'}`}
                    </li>
                  ))}
                </ul>
              ) : null}
              {publishError ? (
                <p className="cc-error" role="alert">
                  {publishError}
                </p>
              ) : null}
              <div className="admin-row-actions">
                <Button onClick={() => void publishCreated()} loading={publishing}>
                  {org?.require_activity_approval ? '提交平台审核' : '直接发布'}
                </Button>
                <Link to={`/admin/activities/${created.id}`}>
                  <Button variant="secondary">进入活动详情</Button>
                </Link>
              </div>
              <p className="admin-muted admin-section">发布后活动详情页公开可见；暂不发布也可稍后在详情页操作。</p>
            </Card>
          ) : (
            <>
              <Card title="现场与问卷计划" className="admin-section">
                <p>
                  现场配对：{pairingEnabled ? '启用' : '关闭'} · 预计签到开放：
                  {plannedCheckin ? formatDateTime(fromInputDateTime(plannedCheckin)) : '未设置'}
                </p>
                {surveyPicks.map((pick) => (
                  <p key={pick.templateId}>
                    {pick.title} · {{ before: '活动前', onsite: '现场', after: '活动后' }[pick.phase]} ·{' '}
                    {pick.plannedOpen ? formatDateTime(fromInputDateTime(pick.plannedOpen)) : '开放时间待安排'}
                  </p>
                ))}
                <p className="admin-muted">预计时间仅作提示，实际开放请在活动详情中手动操作。</p>
              </Card>
              <Card title="参与者端预览" className="admin-section">
                <div className="admin-preview">
                  <div>
                    <h3 className="admin-preview-title">{title.trim() || '（未填写标题）'}</h3>
                    <p className="admin-muted">
                      {startTime ? formatDateTime(fromInputDateTime(startTime)) : '（未设置时间）'}
                      {endTime ? ` 至 ${formatDateTime(fromInputDateTime(endTime))}` : ''}
                      {location.trim() ? ` · ${location.trim()}` : ''}
                    </p>
                    <p>{description.trim() || '（暂无活动介绍）'}</p>
                    <p className="admin-muted">
                      名额 {Number.isInteger(parsedCapacity) && parsedCapacity > 0 ? parsedCapacity : '—'} 人
                      （倾诉者/聆听者对半） · 报名{registrationOpen ? '开放' : '关闭'}
                    </p>
                  </div>
                  <div className="admin-preview-form">
                    <div className="admin-row-actions" role="group" aria-label="预览报名角色">
                      <Button
                        variant={previewRole === 'speaker' ? 'primary' : 'secondary'}
                        onClick={() => setPreviewRole('speaker')}
                      >
                        倾诉者报名表
                      </Button>
                      <Button
                        variant={previewRole === 'listener' ? 'primary' : 'secondary'}
                        onClick={() => setPreviewRole('listener')}
                      >
                        聆听者报名表
                      </Button>
                    </div>
                    {previewFields.length === 0 ? (
                      <p className="admin-empty">当前角色无启用字段（回到「角色与报名」启用字段）。</p>
                    ) : null}
                    {previewFields.map(({ config, def }) => (
                      <div key={def.id} className="cc-field">
                        <span className="cc-label">
                          {def.label}
                          {config.required ? (
                            <span className="cc-required" aria-hidden="true">
                              *
                            </span>
                          ) : null}
                          <span className="admin-muted">（{FIELD_TYPE_LABELS[def.field_type]}）</span>
                        </span>
                        <PreviewControl def={def} />
                      </div>
                    ))}
                  </div>
                </div>
              </Card>

              <Card title="缺失项与下一步" className="admin-section">
                {missingItems.length === 0 ? (
                  <p>配置完整，可以创建草稿{org?.require_activity_approval ? '并提交平台审核' : '并发布'}。</p>
                ) : (
                  <ul className="admin-note-list">
                    {missingItems.map((item) => (
                      <li key={item.key}>{item.message}</li>
                    ))}
                  </ul>
                )}
                {!defsReady ? (
                  <p className="cc-hint" role="note">
                    {defsError
                      ? '报名字段定义加载失败，暂不能创建（避免空配置覆盖报名表）；请返回上一步重试。'
                      : '报名字段定义加载中，加载完成后才能创建。'}
                  </p>
                ) : null}
                {submitError ? (
                  <p className="cc-error" role="alert">
                    {submitError}
                  </p>
                ) : null}
                <div className="admin-row-actions">
                  <Button onClick={() => void submitCreate()} loading={submitting} disabled={!defsReady}>
                    创建草稿
                  </Button>
                </div>
              </Card>
            </>
          )}
        </div>
      ) : null}

      {!created ? (
        <div className="admin-row-actions admin-section">
          {stepIndex > 0 ? (
            <Button variant="secondary" onClick={goPrev} disabled={submitting}>
              上一步
            </Button>
          ) : null}
          {stepIndex < STEPS.length - 1 ? <Button onClick={goNext}>下一步</Button> : null}
          <Link to="/admin/activities" className="admin-muted">
            放弃并返回活动列表
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/** 报名表预览的只读控件（按字段类型渲染形态，不参与提交）。 */
function PreviewControl({ def }: { def: RegistrationFieldDefRecord }) {
  const options =
    def.options_json && typeof def.options_json === 'object'
      ? ((def.options_json as { options?: Array<{ value: string; label: string }> }).options ?? [])
      : [];
  if (def.field_type === 'single_choice') {
    return (
      <select className="admin-select" disabled aria-label={`${def.label}（预览）`}>
        <option value="">请选择</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (def.field_type === 'multi_choice') {
    return (
      <div>
        {options.map((o) => (
          <label key={o.value} className="admin-checkbox-row">
            <input type="checkbox" disabled />
            {o.label}
          </label>
        ))}
      </div>
    );
  }
  if (def.field_type === 'date') {
    return <input className="cc-input" type="date" disabled aria-label={`${def.label}（预览）`} />;
  }
  return (
    <input
      className="cc-input"
      type={def.field_type === 'number' ? 'number' : 'text'}
      disabled
      placeholder={def.field_type === 'text' ? '单行文本' : ''}
      aria-label={`${def.label}（预览）`}
    />
  );
}
