import { useCallback, useEffect, useState } from 'react';
import type {
  ActivityRecord,
  ActivitySurveyRecord,
  AnswerRecord,
  QuestionType,
  RoleScope,
  SubmissionRecord,
  SurveyQuestionRecord,
  SurveyTemplateRecord,
} from '../../../../shared/api/types';
import { normalizeApiError } from '../../../../shared/api/http';
import { Button, Card, Input, Loading, Modal } from '../../../../shared/ui';
import { QrDisplay } from '../../components/QrDisplay';
import { ReasonModal } from '../../components/ReasonModal';
import { StatusTag, type StatusTone } from '../../components/StatusTag';
import {
  adminCollections,
  createActivitySurvey,
  runSurveyAction,
  voidSubmission,
} from '../../lib/api';
import {
  QUESTION_TYPE_LABELS,
  ROLE_SCOPE_LABELS,
  SOURCE_TYPE_LABELS,
  SUBMISSION_STATUS_LABELS,
  SURVEY_STATUS_LABELS,
} from '../../lib/labels';
import { formatDateTime, shortId } from '../../lib/format';
import { ADMIN_SURVEY_ACTION_LABELS, availableSurveyActions } from '../../lib/rules';

const STATUS_TONES: Record<ActivitySurveyRecord['status'], StatusTone> = {
  draft: 'neutral',
  not_open: 'neutral',
  open: 'success',
  ended: 'warning',
  archived: 'neutral',
};

/**
 * 问卷管理（活动详情子页，FR-SUR-001~012）。
 *
 * - 从模板复制创建：POST /api/cc/activities/:id/surveys（取模板当前版本物化题目，
 *   创建后不随模板升级，AC-13）；
 * - 题目编辑走 survey_questions 集合 API：锁定题只读展示（FR-SUR-001），
 *   自定义题可新增/编辑/排序（必填 + 敏感标记，FR-SUR-002、§8.3）；
 *   V1 无删除入口（无硬删除 FR-AUD-001，survey_questions.deleteRule 关闭）；
 * - 开放/结束手动控制（PRD §8.2），独立链接 /survey/:qrToken 固定；
 * - 答卷作废 reason 必填 + 审计（FR-SUR-010），作废记录保留且统计/导出排除。
 */
export function SurveyPanel({ activity }: { activity: ActivityRecord }) {
  const [surveys, setSurveys] = useState<ActivitySurveyRecord[] | null>(null);
  const [templates, setTemplates] = useState<SurveyTemplateRecord[]>([]);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createTemplateId, setCreateTemplateId] = useState('');
  const [createRoleScope, setCreateRoleScope] = useState<RoleScope>('both');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const cc = adminCollections();
      const [surveyList, templateList] = await Promise.all([
        cc.activitySurveys.getFullList({
          filter: `activity_id = "${activity.id}"`,
          sort: '-created',
        }),
        cc.surveyTemplates.getFullList({ filter: 'status = "active"' }),
      ]);
      setSurveys(surveyList);
      setTemplates(templateList);
    } catch (err) {
      setError(normalizeApiError(err).message);
    }
  }, [activity.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitCreate = async () => {
    const template = templates.find((t) => t.id === createTemplateId);
    if (!template) {
      setCreateError('请选择问卷模板');
      return;
    }
    if (!createTitle.trim()) {
      setCreateError('请输入问卷标题');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      await createActivitySurvey(activity.id, {
        template_version_id: template.current_version_id,
        title: createTitle.trim(),
        role_scope: createRoleScope,
      });
      setShowCreate(false);
      setCreateTitle('');
      setCreateTemplateId('');
      setCreateRoleScope('both');
      await load();
    } catch (err) {
      setCreateError(normalizeApiError(err).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <div className="admin-toolbar">
        <Button
          onClick={() => {
            setCreateError('');
            setShowCreate(true);
          }}
        >
          从模板创建问卷
        </Button>
        <Button variant="secondary" onClick={() => void load()}>
          刷新
        </Button>
      </div>

      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
      {surveys === null && !error ? <Loading label="问卷加载中…" /> : null}
      {surveys !== null && surveys.length === 0 && !error ? (
        <p className="admin-empty">暂无问卷，点击「从模板创建问卷」复制标准模板生成活动问卷。</p>
      ) : null}
      {surveys?.map((survey) => (
        <SurveyCard key={survey.id} survey={survey} onChanged={load} />
      ))}

      <Modal
        open={showCreate}
        title="从模板创建问卷"
        onClose={() => setShowCreate(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowCreate(false)} disabled={creating}>
              取消
            </Button>
            <Button onClick={() => void submitCreate()} loading={creating}>
              创建
            </Button>
          </>
        }
      >
        <div className="cc-field">
          <label className="cc-label" htmlFor="survey-template">
            问卷模板
            <span className="cc-required" aria-hidden="true">
              *
            </span>
          </label>
          <select
            id="survey-template"
            className="admin-select"
            value={createTemplateId}
            onChange={(e) => setCreateTemplateId(e.target.value)}
          >
            <option value="">请选择模板（复制其当前版本，FR-SUR-011）</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}（{t.template_code}）
              </option>
            ))}
          </select>
          {templates.length === 0 ? <p className="cc-hint">暂无可用模板，请联系超级管理员发布。</p> : null}
        </div>
        <Input
          label="问卷标题"
          value={createTitle}
          onChange={(e) => setCreateTitle(e.target.value)}
          required
        />
        <div className="cc-field">
          <label className="cc-label" htmlFor="survey-role-scope">
            适用角色
          </label>
          <select
            id="survey-role-scope"
            className="admin-select"
            value={createRoleScope}
            onChange={(e) => setCreateRoleScope(e.target.value as RoleScope)}
          >
            {(Object.keys(ROLE_SCOPE_LABELS) as RoleScope[]).map((scope) => (
              <option key={scope} value={scope}>
                {ROLE_SCOPE_LABELS[scope]}
              </option>
            ))}
          </select>
        </div>
        {createError ? (
          <p className="cc-error" role="alert">
            {createError}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}

/** 单份活动问卷卡片：状态动作、题目管理、链接二维码、答卷列表。 */
function SurveyCard({
  survey,
  onChanged,
}: {
  survey: ActivitySurveyRecord;
  onChanged: () => Promise<void> | void;
}) {
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<'' | 'questions' | 'submissions' | 'link'>('');

  const surveyUrl = `${window.location.origin}/survey/${survey.qr_token}`;
  const actions = availableSurveyActions(survey.status);

  const runAction = async (action: (typeof actions)[number]) => {
    setBusy(true);
    setActionError('');
    try {
      await runSurveyAction(survey.id, action);
      await onChanged();
    } catch (err) {
      setActionError(normalizeApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: typeof section) => setSection((prev) => (prev === key ? '' : key));

  return (
    <Card
      className="admin-section"
      title={survey.title}
      actions={<StatusTag label={SURVEY_STATUS_LABELS[survey.status]} tone={STATUS_TONES[survey.status]} />}
    >
      <p className="admin-muted">
        代码 <code>{survey.survey_code}</code> · 适用角色：{ROLE_SCOPE_LABELS[survey.role_scope]}
        {survey.opened_at ? ` · 开放于 ${formatDateTime(survey.opened_at)}` : ''}
        {survey.ended_at ? ` · 结束于 ${formatDateTime(survey.ended_at)}` : ''}
      </p>
      <div className="admin-row-actions">
        {actions.map((action) => (
          <Button
            key={action}
            variant={action === 'close' ? 'danger' : 'primary'}
            loading={busy}
            onClick={() => void runAction(action)}
          >
            {ADMIN_SURVEY_ACTION_LABELS[action]}
          </Button>
        ))}
        <Button variant="secondary" onClick={() => toggle('questions')}>
          {section === 'questions' ? '收起题目' : '题目管理'}
        </Button>
        <Button variant="secondary" onClick={() => toggle('link')}>
          {section === 'link' ? '收起链接' : '链接与二维码'}
        </Button>
        <Button variant="secondary" onClick={() => toggle('submissions')}>
          {section === 'submissions' ? '收起答卷' : '答卷列表'}
        </Button>
      </div>
      {actionError ? (
        <p className="cc-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {section === 'link' ? (
        <div className="admin-section">
          <QrDisplay url={surveyUrl} caption="问卷独立链接/二维码（token 不可连续可猜，PRD §10.3）" />
        </div>
      ) : null}
      {section === 'questions' ? <QuestionManager survey={survey} /> : null}
      {section === 'submissions' ? <SubmissionList survey={survey} /> : null}
    </Card>
  );
}

/** 题目管理：锁定题只读；自定义题新增/编辑/排序（必填 + 敏感标记）。 */
function QuestionManager({ survey }: { survey: ActivitySurveyRecord }) {
  const [questions, setQuestions] = useState<SurveyQuestionRecord[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<SurveyQuestionRecord | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const list = await adminCollections().surveyQuestions.getFullList({
        filter: `activity_survey_id = "${survey.id}"`,
        sort: 'order_index',
      });
      setQuestions(list);
    } catch (err) {
      setError(normalizeApiError(err).message);
    }
  }, [survey.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 上移/下移：与相邻题交换 order_index（两次集合更新，服务端无事务需求——排序非关键不变量）。 */
  const move = async (index: number, direction: -1 | 1) => {
    if (!questions) return;
    const target = index + direction;
    if (target < 0 || target >= questions.length) return;
    const a = questions[index];
    const b = questions[target];
    try {
      const cc = adminCollections().surveyQuestions;
      await cc.update(a.id, { order_index: b.order_index });
      await cc.update(b.id, { order_index: a.order_index });
      await load();
    } catch (err) {
      setError(normalizeApiError(err).message);
    }
  };

  return (
    <div className="admin-section">
      <div className="admin-row-actions">
        <Button variant="secondary" onClick={() => setShowAdd(true)}>
          新增自定义题
        </Button>
      </div>
      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
      {questions === null && !error ? <Loading label="题目加载中…" /> : null}
      {questions && questions.length === 0 ? <p className="admin-empty">暂无题目。</p> : null}
      {questions && questions.length > 0 ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>#</th>
                <th>题目</th>
                <th>题型</th>
                <th>来源</th>
                <th>标记</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {questions.map((q, index) => (
                <tr key={q.id}>
                  <td>{index + 1}</td>
                  <td>
                    {q.title}
                    <br />
                    <code className="admin-muted">{q.question_code}</code>
                  </td>
                  <td>{QUESTION_TYPE_LABELS[q.question_type]}</td>
                  <td>
                    {SOURCE_TYPE_LABELS[q.source_type]}
                    {q.locked ? (
                      <>
                        {' '}
                        <StatusTag label="锁定" tone="warning" />
                      </>
                    ) : null}
                  </td>
                  <td>
                    {q.required ? <StatusTag label="必填" tone="info" /> : null}{' '}
                    {q.is_sensitive ? <StatusTag label="敏感" tone="danger" /> : null}
                  </td>
                  <td>
                    <div className="admin-row-actions">
                      <Button variant="secondary" disabled={index === 0} onClick={() => void move(index, -1)}>
                        上移
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={index === questions.length - 1}
                        onClick={() => void move(index, 1)}
                      >
                        下移
                      </Button>
                      {!q.locked ? (
                        <Button variant="secondary" onClick={() => setEditing(q)}>
                          编辑
                        </Button>
                      ) : (
                        <span className="admin-muted">只读</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <QuestionFormModal
        open={showAdd}
        title="新增自定义题"
        survey={survey}
        nextOrderIndex={questions ? Math.max(0, ...questions.map((q) => q.order_index)) + 1 : 1}
        onClose={() => setShowAdd(false)}
        onSaved={() => {
          setShowAdd(false);
          void load();
        }}
      />
      <QuestionFormModal
        open={editing !== null}
        title="编辑自定义题"
        survey={survey}
        initial={editing ?? undefined}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </div>
  );
}

/** 自定义题新增/编辑表单（锁定题不可进入编辑；question_code 生成后稳定不可改）。 */
function QuestionFormModal({
  open,
  title,
  survey,
  initial,
  nextOrderIndex,
  onClose,
  onSaved,
}: {
  open: boolean;
  title: string;
  survey: ActivitySurveyRecord;
  initial?: SurveyQuestionRecord;
  nextOrderIndex?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [questionTitle, setQuestionTitle] = useState('');
  const [questionType, setQuestionType] = useState<QuestionType>('text_short');
  const [required, setRequired] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const [options, setOptions] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuestionTitle(initial?.title ?? '');
    setQuestionType(initial?.question_type ?? 'text_short');
    setRequired(initial?.required ?? false);
    setSensitive(initial?.is_sensitive ?? false);
    setOptions(optionsJsonToText(initial?.options_json));
    setError('');
  }, [open, initial]);

  const isChoice = questionType === 'single_choice' || questionType === 'multi_choice';

  const submit = async () => {
    if (!questionTitle.trim()) {
      setError('请输入题干');
      return;
    }
    if (isChoice && !parseOptions(options)) {
      setError('选择题需填写选项（每行一条）');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const cc = adminCollections().surveyQuestions;
      if (initial) {
        await cc.update(initial.id, {
          title: questionTitle.trim(),
          required,
          is_sensitive: sensitive,
          options_json: parseOptions(options),
        });
      } else {
        await cc.create({
          activity_survey_id: survey.id,
          question_code: `CUS_${Date.now().toString(36).toUpperCase()}`,
          source_type: 'custom',
          question_type: questionType,
          title: questionTitle.trim(),
          required,
          is_sensitive: sensitive,
          options_json: parseOptions(options),
          locked: false,
          order_index: nextOrderIndex ?? 1,
        });
      }
      onSaved();
    } catch (err) {
      setError(normalizeApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={() => void submit()} loading={submitting}>
            保存
          </Button>
        </>
      }
    >
      <Input label="题干" value={questionTitle} onChange={(e) => setQuestionTitle(e.target.value)} required />
      {initial ? null : (
        <div className="cc-field">
          <label className="cc-label" htmlFor="question-type">
            题型
          </label>
          <select
            id="question-type"
            className="admin-select"
            value={questionType}
            onChange={(e) => setQuestionType(e.target.value as QuestionType)}
          >
            {Object.entries(QUESTION_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}
      {isChoice ? (
        <div className="cc-field">
          <label className="cc-label" htmlFor="question-options">
            选项（每行一条，格式：机器值,显示文本 或仅显示文本）
          </label>
          <textarea
            id="question-options"
            className="cc-input cc-textarea"
            rows={3}
            value={options}
            onChange={(e) => setOptions(e.target.value)}
          />
        </div>
      ) : null}
      <label className="admin-checkbox-row">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
        必填
      </label>
      <label className="admin-checkbox-row">
        <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
        标记为敏感题目（普通导出过滤，FR-SUR-012）
      </label>
      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/** 答卷列表（不含草稿）；作废 reason 必填；答案只读查看。 */
function SubmissionList({ survey }: { survey: ActivitySurveyRecord }) {
  const [submissions, setSubmissions] = useState<SubmissionRecord[] | null>(null);
  const [error, setError] = useState('');
  const [voidTarget, setVoidTarget] = useState<SubmissionRecord | null>(null);
  const [answersFor, setAnswersFor] = useState<SubmissionRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const list = await adminCollections().submissions.getFullList({
        filter: `activity_survey_id = "${survey.id}" && status != "draft"`,
        sort: '-submitted_at',
      });
      setSubmissions(list);
    } catch (err) {
      setError(normalizeApiError(err).message);
    }
  }, [survey.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitVoid = async (reason: string) => {
    if (!voidTarget) return;
    setBusy(true);
    setActionError('');
    try {
      await voidSubmission(voidTarget.id, reason);
      setVoidTarget(null);
      await load();
    } catch (err) {
      setActionError(normalizeApiError(err).message);
      throw err;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-section">
      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
      {actionError ? (
        <p className="cc-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {submissions === null && !error ? <Loading label="答卷加载中…" /> : null}
      {submissions !== null && submissions.length === 0 && !error ? (
        <p className="admin-empty">暂无已提交答卷。</p>
      ) : null}
      {submissions && submissions.length > 0 ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>参与者</th>
                <th>状态</th>
                <th>提交时间</th>
                <th>作废信息</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <code title={s.participant_id}>{shortId(s.participant_id)}</code>
                  </td>
                  <td>
                    <StatusTag
                      label={SUBMISSION_STATUS_LABELS[s.status]}
                      tone={s.status === 'submitted' ? 'success' : 'danger'}
                    />
                  </td>
                  <td>{formatDateTime(s.submitted_at)}</td>
                  <td className="admin-muted">
                    {s.status === 'voided'
                      ? `${formatDateTime(s.voided_at)} · ${s.void_reason || '—'}`
                      : '—'}
                  </td>
                  <td>
                    <div className="admin-row-actions">
                      <Button variant="secondary" onClick={() => setAnswersFor(s)}>
                        查看答案
                      </Button>
                      {s.status === 'submitted' ? (
                        <Button variant="danger" onClick={() => setVoidTarget(s)}>
                          作废
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <ReasonModal
        open={voidTarget !== null}
        title="作废答卷"
        confirmLabel="确认作废"
        confirmVariant="danger"
        reasonRequired
        reasonLabel="作废原因"
        submitting={busy}
        onClose={() => setVoidTarget(null)}
        onSubmit={submitVoid}
      >
        <p className="admin-muted">
          作废后原记录保留并写审计（FR-SUR-010）；该答卷不再计入统计与导出，且 V1 不支持重填。
        </p>
        {actionError ? (
          <p className="cc-error" role="alert">
            {actionError}
          </p>
        ) : null}
      </ReasonModal>

      <SubmissionAnswersModal survey={survey} submission={answersFor} onClose={() => setAnswersFor(null)} />
    </div>
  );
}

/** 答卷答案只读查看（按 question_code 关联题目，历史答案不受题目后续调整影响，PRD §9.2）。 */
function SubmissionAnswersModal({
  survey,
  submission,
  onClose,
}: {
  survey: ActivitySurveyRecord;
  submission: SubmissionRecord | null;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<{ code: string; title: string; value: string }[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!submission) {
      setRows(null);
      setError('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cc = adminCollections();
        const [answers, questions] = await Promise.all([
          cc.answers.getFullList({ filter: `submission_id = "${submission.id}"` }),
          cc.surveyQuestions.getFullList({ filter: `activity_survey_id = "${survey.id}"` }),
        ]);
        const titleByCode = new Map(questions.map((q) => [q.question_code, q.title]));
        if (cancelled) return;
        setRows(
          answers.map((a: AnswerRecord) => ({
            code: a.question_code,
            title: titleByCode.get(a.question_code) ?? a.question_code,
            value: formatAnswer(a.value_json),
          })),
        );
      } catch (err) {
        if (!cancelled) setError(normalizeApiError(err).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [submission, survey.id]);

  return (
    <Modal open={submission !== null} title="答卷答案（只读）" onClose={onClose}>
      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
      {rows === null && !error ? <Loading label="答案加载中…" /> : null}
      {rows && rows.length === 0 ? <p className="admin-empty">无答案记录。</p> : null}
      {rows && rows.length > 0 ? (
        <table className="admin-table">
          <thead>
            <tr>
              <th>题目</th>
              <th>答案</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.code}>
                <td>{row.title}</td>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Modal>
  );
}

function formatAnswer(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join('、');
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function parseOptions(text: string): { options: { value: string; label: string }[] } | undefined {
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

function optionsJsonToText(optionsJson: unknown): string {
  if (
    optionsJson &&
    typeof optionsJson === 'object' &&
    Array.isArray((optionsJson as { options?: unknown }).options)
  ) {
    return (optionsJson as { options: { value: string; label: string }[] }).options
      .map((o) => `${o.value},${o.label}`)
      .join('\n');
  }
  return '';
}
