import { useCallback, useEffect, useState } from 'react';
import type {
  ActivityRecord,
  ActivitySurveyRecord,
  AnswerRecord,
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
import { SurveyQuestionEditor } from '../../components/SurveyQuestionEditor';
import { adminCollections, createActivitySurvey, runSurveyAction, voidSubmission } from '../../lib/api';
import { ROLE_SCOPE_LABELS, SUBMISSION_STATUS_LABELS, SURVEY_STATUS_LABELS } from '../../lib/labels';
import { formatDateTime, fromInputDateTime, toInputDateTime, shortId } from '../../lib/format';
import { ADMIN_SURVEY_ACTION_LABELS, availableSurveyActions } from '../../lib/rules';
import { applyQuestionChanges } from '../../lib/surveyQuestionApply';

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
 * - 题目编辑复用超管端可视化编辑器（components/SurveyQuestionEditor，草稿模型见
 *   shared/survey/questionDrafts）：锁定题只读且为排序锚点、不可跨过（FR-SUR-001），
 *   自定义题可新增/编辑/排序（必填 + 敏感标记，FR-SUR-002、§8.3），
 *   落库经 lib/surveyQuestionApply（创建/更新/槽位重排）；
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
        <Input label="问卷标题" value={createTitle} onChange={(e) => setCreateTitle(e.target.value)} required />
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
function SurveyCard({ survey, onChanged }: { survey: ActivitySurveyRecord; onChanged: () => Promise<void> | void }) {
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<'' | 'questions' | 'submissions' | 'link'>('');

  const [phase, setPhase] = useState(survey.phase || 'onsite');
  const [planned, setPlanned] = useState(toInputDateTime(survey.planned_open_at));
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
      <details className="admin-section">
        <summary>问卷阶段与预计开放时间</summary>
        <label>
          问卷阶段
          <select
            className="admin-select"
            value={phase}
            onChange={(e) => setPhase(e.target.value as NonNullable<ActivitySurveyRecord['phase']>)}
          >
            <option value="before">活动前</option>
            <option value="onsite">现场</option>
            <option value="after">活动后</option>
          </select>
        </label>
        <Input
          label="预计开放时间"
          type="datetime-local"
          value={planned}
          onChange={(e) => setPlanned(e.target.value)}
          hint="仅作提示，实际开放/结束仍需手动操作。"
        />
        <Button
          variant="secondary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setActionError('');
            try {
              await adminCollections().activitySurveys.update(survey.id, {
                phase,
                planned_open_at: fromInputDateTime(planned) || '',
              });
              await onChanged();
            } catch (err) {
              setActionError(normalizeApiError(err).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          保存问卷计划
        </Button>
      </details>
      <p className="admin-muted">
        阶段：{{ before: '活动前', onsite: '现场', after: '活动后' }[survey.phase || 'onsite']} · 预计开放：
        {survey.planned_open_at ? formatDateTime(survey.planned_open_at) : '未设置'}
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

/** 题目管理：可视化编辑器；锁定题只读且为排序锚点，自定义题新增/编辑/排序。 */
function QuestionManager({ survey }: { survey: ActivitySurveyRecord }) {
  const [questions, setQuestions] = useState<SurveyQuestionRecord[] | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

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

  return (
    <div className="admin-section">
      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
      {questions === null && !error ? <Loading label="题目加载中…" /> : null}
      {questions !== null ? (
        <SurveyQuestionEditor
          survey={survey}
          questions={questions}
          saving={saving}
          onSubmit={async (drafts) => {
            // 错误不在此捕获：try/finally 只复位 saving，错误原样抛给编辑器内联展示
            setSaving(true);
            try {
              await applyQuestionChanges(survey.id, drafts, questions);
              await load();
            } finally {
              setSaving(false);
            }
          }}
        />
      ) : null}
    </div>
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
                    {s.status === 'voided' ? `${formatDateTime(s.voided_at)} · ${s.void_reason || '—'}` : '—'}
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
