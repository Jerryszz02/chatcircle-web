import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ExportPreviewResponse } from '../../../shared/api/accountEvent';
import { normalizeApiError } from '../../../shared/api/http';
import type {
  ActivityRecord,
  ActivitySurveyRecord,
  OrganizationRecord,
  RegistrationFieldDefRecord,
  SurveyQuestionRecord,
} from '../../../shared/api/types';
import { Button } from '../../../shared/ui';
import { createExportV2, previewExportV2, adminCollections } from '../lib/api';
import {
  ACTIVITY_ROLE_OPTIONS,
  applyExportPreset,
  buildExportSelection,
  CHECKIN_FILTER_OPTIONS,
  clientSensitiveHints,
  EXPORT_DATASET_LABELS,
  EXPORT_PRESETS,
  EXPORT_SYSTEM_COLUMN_LABELS,
  EXPORT_TIMEZONES,
  initialExportWizardState,
  PAIRING_FILTER_OPTIONS,
  REGISTRATION_STATUS_OPTIONS,
  SURVEY_COMPLETION_OPTIONS,
  validateExportWizardStep,
  type ExportWizardState,
} from '../lib/exportWizard';

/**
 * T6 五步导出向导（PRD §7）：范围 → 数据域 → 行筛选 → 字段 → 格式。
 *
 * - 字段/题目选项来自服务端定义（registration_field_defs / survey_questions），
 *   敏感标记只读展示（is_sensitive badge），判敏门槛以服务端 preview 为准；
 * - 第 5 步先调 preview（预估行数 + requires_sensitive_export + 权限），
 *   敏感导出须勾选二次确认后才可创建；选择变更后预览自动失效须重新预览；
 * - 创建成功后回调刷新导出记录列表。
 */
export function ExportWizard({
  org,
  activities,
  onCreated,
}: {
  org: OrganizationRecord | null;
  activities: ActivityRecord[];
  onCreated: () => void;
}) {
  const [step, setStep] = useState(1);
  const [state, setState] = useState<ExportWizardState>(initialExportWizardState);
  const [errors, setErrors] = useState<string[]>([]);

  // 步骤 4 元数据：报名字段定义 + 范围内问卷与题目
  const [fieldDefs, setFieldDefs] = useState<RegistrationFieldDefRecord[]>([]);
  const [surveys, setSurveys] = useState<ActivitySurveyRecord[]>([]);
  const [questions, setQuestions] = useState<SurveyQuestionRecord[]>([]);
  const [metaLoading, setMetaLoading] = useState(false);

  const [preview, setPreview] = useState<ExportPreviewResponse | null>(null);
  const [previewKey, setPreviewKey] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [confirmSensitive, setConfirmSensitive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [doneJobId, setDoneJobId] = useState('');

  const patch = useCallback((p: Partial<ExportWizardState>) => {
    setState((prev) => ({ ...prev, ...p }));
    setPreview(null); // 选择变更后预览失效，须重新预览
    setConfirmSensitive(false);
  }, []);

  const scopeActivityIds = useMemo(
    () =>
      state.scopeType === 'activity'
        ? activities.filter((a) => a.id === state.activityId).map((a) => a.id)
        : activities.map((a) => a.id),
    [activities, state.scopeType, state.activityId],
  );
  const scopeKey = `${state.scopeType}:${state.activityId || 'org'}`;

  // 进入第 2 步时按范围加载字段/问卷元数据（预设展开与字段步骤共用）
  useEffect(() => {
    if (step < 2 || metaLoading) return;
    let cancelled = false;
    setMetaLoading(true);
    const cc = adminCollections();
    void (async () => {
      try {
        const [defs, surveyList] = await Promise.all([
          cc.registrationFieldDefs.getFullList({ filter: 'status = "active"', sort: 'created' }),
          cc.activitySurveys.getFullList({ sort: 'created' }),
        ]);
        if (cancelled) return;
        const scopedSurveys = surveyList.filter((s) => scopeActivityIds.includes(s.activity_id));
        const surveyIds = new Set(scopedSurveys.map((s) => s.id));
        const questionList = await cc.surveyQuestions.getFullList({ sort: 'order_index' });
        if (cancelled) return;
        setFieldDefs(defs);
        setSurveys(scopedSurveys);
        setQuestions(questionList.filter((q) => surveyIds.has(q.activity_survey_id)));
      } catch {
        if (!cancelled) setErrors(['字段/问卷元数据加载失败，请返回上一步重试']);
      } finally {
        if (!cancelled) setMetaLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // scopeKey 覆盖 scopeActivityIds 变化；activities 列表本身不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, scopeKey]);

  const selection = useMemo(() => buildExportSelection(state), [state]);
  const selectionKey = JSON.stringify(selection);
  const previewFresh = preview !== null && previewKey === selectionKey;

  const fieldMeta = useMemo(
    () => fieldDefs.map((d) => ({ field_code: d.field_code, is_sensitive: d.is_sensitive })),
    [fieldDefs],
  );
  const questionMeta = useMemo(
    () =>
      questions.map((q) => ({
        activity_survey_id: q.activity_survey_id,
        question_code: q.question_code,
        is_sensitive: q.is_sensitive,
      })),
    [questions],
  );
  const sensitiveHints = useMemo(
    () => clientSensitiveHints(state, { fields: fieldMeta, questions: questionMeta }),
    [state, fieldMeta, questionMeta],
  );

  const goNext = () => {
    const errs = validateExportWizardStep(state, step);
    setErrors(errs);
    if (errs.length === 0) setStep(step + 1);
  };
  const goBack = () => {
    setErrors([]);
    setStep(step - 1);
  };

  const handlePreset = (code: string) => {
    const preset = EXPORT_PRESETS.find((p) => p.code === code);
    if (!preset) return;
    patch(applyExportPreset(preset, { fields: fieldMeta, questions: questionMeta }));
  };

  const doPreview = async () => {
    const errs = validateExportWizardStep(state, 5);
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    setPreviewing(true);
    setErrors([]);
    try {
      const res = await previewExportV2(selection);
      setPreview(res);
      setPreviewKey(selectionKey);
      setConfirmSensitive(false);
    } catch (err) {
      setErrors([normalizeApiError(err).message]);
    } finally {
      setPreviewing(false);
    }
  };

  const doCreate = async () => {
    setSubmitting(true);
    setErrors([]);
    try {
      const res = await createExportV2({ ...selection, confirm_sensitive: confirmSensitive });
      setDoneJobId(res.export_job_id);
      onCreated();
    } catch (err) {
      setErrors([normalizeApiError(err).message]);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleIn = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const toggleQuestion = (surveyId: string, code: string) => {
    const next = state.questionSelections.map((q) => ({
      activity_survey_id: q.activity_survey_id,
      question_codes: [...q.question_codes],
    }));
    const idx = next.findIndex((q) => q.activity_survey_id === surveyId);
    if (idx < 0) {
      next.push({ activity_survey_id: surveyId, question_codes: [code] });
    } else {
      const codes = next[idx].question_codes;
      next[idx] = {
        activity_survey_id: surveyId,
        question_codes: codes.includes(code) ? codes.filter((c) => c !== code) : [...codes, code],
      };
    }
    patch({ questionSelections: next.filter((q) => q.question_codes.length > 0) });
  };

  const surveysForQuestions = surveys.filter(
    (s) => state.surveyIds.length === 0 || state.surveyIds.includes(s.id),
  );
  const sensitiveAllowed = org?.allow_sensitive_export === true;

  if (doneJobId) {
    return (
      <div className="cc-field">
        <p className="admin-muted">
          导出任务已创建（任务 ID：<code>{doneJobId}</code>）。文件生成完成后可在下方「导出记录」下载。
        </p>
        <Button
          variant="secondary"
          onClick={() => {
            setDoneJobId('');
            setState(initialExportWizardState());
            setStep(1);
            setPreview(null);
          }}
        >
          再建一个导出
        </Button>
      </div>
    );
  }

  return (
    <div className="cc-field">
      <p className="admin-muted" aria-live="polite">
        第 {step} / 5 步 · {['范围', '数据域', '行筛选', '字段', '格式'][step - 1]}
      </p>

      {step === 1 ? (
        <>
          <span className="cc-label">导出范围</span>
          <label className="admin-checkbox-row">
            <input
              type="radio"
              name="wz-scope"
              checked={state.scopeType === 'organization'}
              onChange={() => patch({ scopeType: 'organization', activityId: '' })}
            />
            本机构全部活动
          </label>
          <label className="admin-checkbox-row">
            <input
              type="radio"
              name="wz-scope"
              checked={state.scopeType === 'activity'}
              onChange={() => patch({ scopeType: 'activity' })}
            />
            单场活动
          </label>
          {state.scopeType === 'activity' ? (
            <select
              className="admin-select"
              aria-label="选择活动"
              value={state.activityId}
              onChange={(e) => patch({ activityId: e.target.value })}
            >
              <option value="">请选择活动</option>
              {activities.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}（{a.activity_code}）
                </option>
              ))}
            </select>
          ) : null}
          <span className="cc-label">日期范围（可选，按活动时间交集过滤）</span>
          <div className="admin-toolbar">
            <input
              className="admin-select"
              type="date"
              aria-label="开始日期"
              value={state.dateFrom}
              onChange={(e) => patch({ dateFrom: e.target.value })}
            />
            <input
              className="admin-select"
              type="date"
              aria-label="结束日期"
              value={state.dateTo}
              onChange={(e) => patch({ dateTo: e.target.value })}
            />
          </div>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <span className="cc-label">预设模板（可选，自动填充数据域与字段）</span>
          <div className="admin-toolbar" style={{ flexWrap: 'wrap' }}>
            {EXPORT_PRESETS.map((p) => (
              <Button
                key={p.code}
                variant={state.preset === p.code ? 'primary' : 'secondary'}
                onClick={() => handlePreset(p.code)}
                title={p.description}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <span className="cc-label">数据域</span>
          {(Object.keys(EXPORT_DATASET_LABELS) as Array<keyof typeof EXPORT_DATASET_LABELS>).map((d) => (
            <label key={d} className="admin-checkbox-row">
              <input
                type="checkbox"
                checked={state.datasets.includes(d)}
                onChange={() => patch({ datasets: toggleIn(state.datasets, d) })}
              />
              {EXPORT_DATASET_LABELS[d]}
            </label>
          ))}
          {state.datasets.includes('surveys') && surveys.length > 0 ? (
            <>
              <span className="cc-label">问卷范围（不选 = 范围内全部问卷）</span>
              {surveys.map((s) => (
                <label key={s.id} className="admin-checkbox-row">
                  <input
                    type="checkbox"
                    checked={state.surveyIds.includes(s.id)}
                    onChange={() => patch({ surveyIds: toggleIn(state.surveyIds, s.id) })}
                  />
                  {s.title}（{s.survey_code}）
                </label>
              ))}
            </>
          ) : null}
        </>
      ) : null}

      {step === 3 ? (
        <>
          <span className="cc-label">角色</span>
          {ACTIVITY_ROLE_OPTIONS.map((o) => (
            <label key={o.value} className="admin-checkbox-row">
              <input
                type="checkbox"
                checked={state.roles.includes(o.value)}
                onChange={() => patch({ roles: toggleIn(state.roles, o.value) })}
              />
              {o.label}
            </label>
          ))}
          <span className="cc-label">报名状态</span>
          {REGISTRATION_STATUS_OPTIONS.map((o) => (
            <label key={o.value} className="admin-checkbox-row">
              <input
                type="checkbox"
                checked={state.statuses.includes(o.value)}
                onChange={() => patch({ statuses: toggleIn(state.statuses, o.value) })}
              />
              {o.label}
            </label>
          ))}
          <div className="admin-toolbar">
            <label>
              <span className="cc-label">签到</span>
              <select
                className="admin-select"
                aria-label="签到筛选"
                value={state.checkin}
                onChange={(e) => patch({ checkin: e.target.value as ExportWizardState['checkin'] })}
              >
                {CHECKIN_FILTER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="cc-label">配对</span>
              <select
                className="admin-select"
                aria-label="配对筛选"
                value={state.pairing}
                onChange={(e) => patch({ pairing: e.target.value as ExportWizardState['pairing'] })}
              >
                {PAIRING_FILTER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="cc-label">问卷完成</span>
              <select
                className="admin-select"
                aria-label="问卷完成筛选"
                value={state.surveyCompletion}
                onChange={(e) =>
                  patch({ surveyCompletion: e.target.value as ExportWizardState['surveyCompletion'] })
                }
              >
                {SURVEY_COMPLETION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <span className="cc-label">指定参与者（行筛选，可选；ID 用逗号/空格/换行分隔）</span>
          <textarea
            className="admin-select"
            aria-label="指定参与者 ID"
            rows={3}
            value={state.participantIdsText}
            onChange={(e) => patch({ participantIdsText: e.target.value })}
            placeholder="participant_id1, participant_id2…"
          />
        </>
      ) : null}

      {step === 4 ? (
        <>
          <span className="cc-label">系统列</span>
          {(Object.keys(EXPORT_SYSTEM_COLUMN_LABELS) as Array<keyof typeof EXPORT_SYSTEM_COLUMN_LABELS>).map(
            (col) => (
              <label key={col} className="admin-checkbox-row">
                <input
                  type="checkbox"
                  checked={state.systemColumns.includes(col)}
                  onChange={() => patch({ systemColumns: toggleIn(state.systemColumns, col) })}
                />
                {EXPORT_SYSTEM_COLUMN_LABELS[col]}
              </label>
            ),
          )}
          <span className="cc-label">报名字段</span>
          {fieldDefs.length === 0 ? <p className="admin-muted">范围内暂无可选报名字段。</p> : null}
          {fieldDefs.map((d) => (
            <label key={d.id} className="admin-checkbox-row">
              <input
                type="checkbox"
                checked={state.fieldCodes.includes(d.field_code)}
                onChange={() => patch({ fieldCodes: toggleIn(state.fieldCodes, d.field_code) })}
              />
              {d.label}（{d.field_code}）{d.is_sensitive ? '【敏感】' : ''}
            </label>
          ))}
          {state.datasets.includes('surveys') ? (
            <>
              <span className="cc-label">问卷题目</span>
              {surveysForQuestions.length === 0 ? (
                <p className="admin-muted">范围内暂无问卷。</p>
              ) : null}
              {surveysForQuestions.map((s) => (
                <div key={s.id}>
                  <p className="admin-muted">
                    {s.title}（{s.survey_code}）
                  </p>
                  {questions
                    .filter((q) => q.activity_survey_id === s.id)
                    .map((q) => (
                      <label key={q.id} className="admin-checkbox-row">
                        <input
                          type="checkbox"
                          checked={
                            state.questionSelections.find((x) => x.activity_survey_id === s.id)?.question_codes.includes(
                              q.question_code,
                            ) ?? false
                          }
                          onChange={() => toggleQuestion(s.id, q.question_code)}
                        />
                        {q.title}（{q.question_code}）{q.is_sensitive ? '【敏感】' : ''}
                      </label>
                    ))}
                </div>
              ))}
            </>
          ) : null}
          {sensitiveHints.length > 0 ? (
            <p className="admin-muted" role="note">
              已选内容包含敏感项（{sensitiveHints.join('、')}
              ）：创建时将升级为敏感导出，需机构开关与二次确认（以服务端判定为准）。
            </p>
          ) : null}
        </>
      ) : null}

      {step === 5 ? (
        <>
          <span className="cc-label">文件格式</span>
          <label className="admin-checkbox-row">
            <input
              type="radio"
              name="wz-format"
              checked={state.format === 'xlsx'}
              onChange={() => patch({ format: 'xlsx' })}
            />
            XLSX 工作簿（默认，适合机构日常使用）
          </label>
          <label className="admin-checkbox-row">
            <input
              type="radio"
              name="wz-format"
              checked={state.format === 'csv_zip'}
              onChange={() => patch({ format: 'csv_zip' })}
            />
            规范化 CSV ZIP（高级分析）
          </label>
          <span className="cc-label">时区</span>
          <select
            className="admin-select"
            aria-label="时区"
            value={state.timezone}
            onChange={(e) => patch({ timezone: e.target.value })}
          >
            {EXPORT_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>

          {!previewFresh ? (
            <Button variant="secondary" onClick={() => void doPreview()} loading={previewing}>
              生成预览
            </Button>
          ) : null}

          {previewFresh && preview ? (
            <div className="cc-field" aria-live="polite">
              <span className="cc-label">预览结果</span>
              <p className="admin-muted">
                预估行数：
                {Object.entries(preview.estimated_rows)
                  .map(([d, n]) => `${EXPORT_DATASET_LABELS[d as keyof typeof EXPORT_DATASET_LABELS] ?? d} ${n} 行`)
                  .join('；') || '0'}
              </p>
              {preview.requires_sensitive_export ? (
                <p className="cc-error" role="alert">
                  本次导出包含敏感内容（
                  {preview.sensitive_reasons.map((r) => r.code).join('、')}），将写入审计日志。
                </p>
              ) : (
                <p className="admin-muted">本次导出不包含敏感内容。</p>
              )}
              {!preview.permission.allowed ? (
                <p className="cc-error" role="alert">
                  {preview.permission.code === 'sensitive_export_disabled'
                    ? '本机构未开启敏感导出开关，请联系平台超级管理员开启（FR-ORG-005）。'
                    : '所选字段/问卷不存在或已下线，请返回修改。'}
                </p>
              ) : null}
              {preview.requires_sensitive_export && preview.permission.allowed ? (
                <>
                  {!sensitiveAllowed ? (
                    <p className="cc-error" role="alert">
                      本机构未开启敏感导出开关，如需导出请联系平台超级管理员（FR-ORG-005）。
                    </p>
                  ) : null}
                  <label className="admin-checkbox-row">
                    <input
                      type="checkbox"
                      checked={confirmSensitive}
                      onChange={(e) => setConfirmSensitive(e.target.checked)}
                    />
                    我已知晓本次导出包含敏感字段，导出目的正当，文件仅授权人员可访问并妥善保管。
                  </label>
                </>
              ) : null}
              <Button
                onClick={() => void doCreate()}
                loading={submitting}
                disabled={
                  !preview.permission.allowed ||
                  (preview.requires_sensitive_export && (!sensitiveAllowed || !confirmSensitive))
                }
              >
                创建导出任务
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {errors.length > 0 ? (
        <div role="alert">
          {errors.map((err) => (
            <p key={err} className="cc-error">
              {err}
            </p>
          ))}
        </div>
      ) : null}

      <div className="admin-toolbar">
        {step > 1 ? (
          <Button variant="secondary" onClick={goBack} disabled={submitting}>
            上一步
          </Button>
        ) : null}
        {step < 5 ? <Button onClick={goNext}>下一步</Button> : null}
      </div>
    </div>
  );
}
