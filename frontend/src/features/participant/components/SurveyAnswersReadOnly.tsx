import { scaleRange, type SurveyAnswerMap, type SurveyQuestionModel } from '../lib/survey';

/**
 * 已提交答案只读展示（FR-SUR-009：只读，不可修改）。
 * 按题目顺序渲染问题与答案文本；未作答显示「—」。
 */
export function SurveyAnswersReadOnly({
  models,
  answers,
}: {
  models: SurveyQuestionModel[];
  answers: SurveyAnswerMap;
}) {
  const answerText = (model: SurveyQuestionModel): string => {
    const value = answers[model.questionCode];
    if (value === undefined) return '—';
    if (model.questionType === 'multi_choice' && Array.isArray(value)) {
      if (value.length === 0) return '—';
      return value
        .map((v) => model.options.find((o) => o.value === v)?.label ?? v)
        .join('、');
    }
    if (model.questionType === 'single_choice') {
      return model.options.find((o) => o.value === value)?.label ?? String(value);
    }
    if (scaleRange(model.questionType)) return String(value);
    if (typeof value === 'string') return value === '' ? '—' : value;
    return String(value);
  };

  return (
    <dl className="cc-answer-list">
      {models.map((model) =>
        model.questionType === 'info' ? (
          <div key={model.questionCode} className="cc-survey-info">
            <p className="cc-survey-info-text">{model.title}</p>
          </div>
        ) : (
          <div key={model.questionCode} className="cc-answer-item">
            <dt className="cc-answer-question">{model.title}</dt>
            <dd className="cc-answer-value">{answerText(model)}</dd>
          </div>
        ),
      )}
    </dl>
  );
}
