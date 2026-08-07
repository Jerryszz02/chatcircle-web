import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { normalizeApiError } from '../../../shared/api/http';
import { participantAuth } from '../../../shared/auth';
import { Button, Card, Loading, Modal, PageLayout, useToast } from '../../../shared/ui';
import {
  getSubmission,
  getSurveyByToken,
  isUnauthorized,
  saveSurveyDraft,
  submitSurvey,
  type SurveyMeta,
} from '../api';
import { SurveyAnswersReadOnly } from '../components/SurveyAnswersReadOnly';
import { SurveyQuestionField } from '../components/SurveyQuestionField';
import {
  answersToMap,
  buildSurveyAnswersPayload,
  buildSurveyFormModel,
  validateSurveyAnswers,
  type SurveyAnswerMap,
} from '../lib/survey';
import { formatDateTime, surveyIneligibleCopy } from '../lib/status';

/**
 * 问卷填写页（/survey/:qrToken，FR-SUR-006/007/008/009）：
 * - 资格四条件（登录、报名已通过、角色匹配、开放中）由服务端校验，
 *   失败按原因分开展示；
 * - 7 种题型渲染、必填校验、草稿保存（可继续）、正式提交锁定（幂等）；
 * - 已提交（含本次提交后）进入本人答案只读视图。
 */
type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ineligible'; reasons: string[] }
  | { kind: 'form' }
  | { kind: 'readonly'; submittedAt?: string };

export function SurveyPage() {
  const { qrToken = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [meta, setMeta] = useState<SurveyMeta | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [answers, setAnswers] = useState<SurveyAnswerMap>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savingDraft, setSavingDraft] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const models = useMemo(
    () => (meta ? buildSurveyFormModel(meta.questions) : []),
    [meta],
  );

  const load = useCallback(() => {
    if (!qrToken) {
      setPhase({ kind: 'error', message: '链接无效：缺少问卷标识。' });
      return;
    }
    setPhase({ kind: 'loading' });
    getSurveyByToken(qrToken)
      .then(async (res) => {
        setMeta(res);
        if (!res.eligible) {
          setPhase({ kind: 'ineligible', reasons: res.reasons ?? [] });
          return;
        }
        if (res.my_submission?.status === 'submitted') {
          // 已提交：只读展示（FR-SUR-009）；答案优先用元信息下发，缺省回源只读端点。
          let submittedAnswers = res.my_answers;
          if (!submittedAnswers) {
            const detail = await getSubmission(res.my_submission.id);
            submittedAnswers = detail.answers;
          }
          setAnswers(answersToMap(submittedAnswers));
          setPhase({ kind: 'readonly', submittedAt: res.my_submission.submitted_at });
          return;
        }
        // 草稿预填（FR-SUR-008 草稿可继续）。
        setAnswers(res.my_answers ? answersToMap(res.my_answers) : {});
        setPhase({ kind: 'form' });
      })
      .catch((err) => {
        const apiErr = normalizeApiError(err);
        if (isUnauthorized(apiErr)) {
          participantAuth.logout();
          navigate(`/login?redirect=${encodeURIComponent(`/survey/${qrToken}`)}`, {
            replace: true,
          });
          return;
        }
        setPhase({
          kind: 'error',
          message:
            apiErr.status === 404 || apiErr.status === 403
              ? '问卷不存在或未开放'
              : apiErr.message,
        });
      });
  }, [qrToken, navigate]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSaveDraft() {
    if (!meta) return;
    setSavingDraft(true);
    try {
      await saveSurveyDraft(meta.survey.id, buildSurveyAnswersPayload(models, answers));
      toast('草稿已保存，可稍后继续填写', 'success');
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setSavingDraft(false);
    }
  }

  function handleRequestSubmit() {
    const nextErrors = validateSurveyAnswers(models, answers);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setConfirmOpen(true);
  }

  async function handleConfirmSubmit() {
    if (!meta) return;
    setSubmitting(true);
    try {
      const res = await submitSurvey(meta.survey.id, buildSurveyAnswersPayload(models, answers));
      setConfirmOpen(false);
      setPhase({ kind: 'readonly', submittedAt: res.submission.submitted_at });
      toast('提交成功，答卷已锁定', 'success');
    } catch (err) {
      setConfirmOpen(false);
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageLayout
      section="参与者端"
      title={meta ? meta.survey.title : '问卷填写'}
      className="ccp-root"
      actions={
        <Link to="/" className="cc-btn cc-btn-secondary">
          返回首页
        </Link>
      }
    >
      {phase.kind === 'loading' ? <Loading fullscreen /> : null}

      {phase.kind === 'error' ? (
        <Card>
          <p>{phase.message}</p>
          <Link to="/me" className="cc-btn cc-btn-secondary cc-btn-block">
            前往「我的」中心
          </Link>
        </Card>
      ) : null}

      {phase.kind === 'ineligible' ? (
        <Card title="暂不能填写本问卷">
          {phase.reasons.length === 0 ? (
            <p className="cc-hint">当前无法填写本问卷。</p>
          ) : (
            <ul className="cc-reason-list">
              {phase.reasons.map((reason) => {
                const copy = surveyIneligibleCopy(reason);
                return (
                  <li key={reason}>
                    <p className="cc-reason-title">{copy.title}</p>
                    <p className="cc-hint">{copy.detail}</p>
                  </li>
                );
              })}
            </ul>
          )}
          <Link to="/me" className="cc-btn cc-btn-secondary cc-btn-block">
            前往「我的」中心
          </Link>
        </Card>
      ) : null}

      {phase.kind === 'form' && meta ? (
        <>
          <p className="cc-hint">
            所属活动：{meta.activity.title}；带 * 为必答题。草稿可保存后继续，正式提交后将锁定、不能修改（FR-SUR-008）。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleRequestSubmit();
            }}
            noValidate
          >
            {models.map((model) => (
              <SurveyQuestionField
                key={model.questionCode}
                model={model}
                value={answers[model.questionCode]}
                error={errors[model.questionCode]}
                onChange={(v) =>
                  setAnswers((prev) => ({ ...prev, [model.questionCode]: v }))
                }
              />
            ))}
            <div className="cc-actions">
              <Button variant="secondary" block loading={savingDraft} onClick={handleSaveDraft}>
                保存草稿
              </Button>
              <Button type="submit" block>
                正式提交
              </Button>
            </div>
          </form>

          <Modal
            open={confirmOpen}
            title="确认提交"
            onClose={() => (submitting ? undefined : setConfirmOpen(false))}
            footer={
              <>
                <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={submitting}>
                  再检查一下
                </Button>
                <Button onClick={handleConfirmSubmit} loading={submitting}>
                  确认提交
                </Button>
              </>
            }
          >
            <p>正式提交后答卷将锁定，不能再修改或重复提交。确认提交吗？</p>
          </Modal>
        </>
      ) : null}

      {phase.kind === 'readonly' && meta ? (
        <Card
          title="我的答卷（只读）"
          actions={<span className="cc-tag cc-tag-success">已提交</span>}
        >
          {phase.submittedAt ? (
            <p className="cc-hint">提交时间：{formatDateTime(phase.submittedAt)}</p>
          ) : null}
          <SurveyAnswersReadOnly models={models} answers={answers} />
          <Link to="/me" className="cc-btn cc-btn-secondary cc-btn-block">
            前往「我的」中心
          </Link>
        </Card>
      ) : null}
    </PageLayout>
  );
}
