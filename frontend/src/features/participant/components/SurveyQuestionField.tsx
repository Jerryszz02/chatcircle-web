import { useId } from 'react';
import { Input } from '../../../shared/ui';
import { scaleRange, type SurveyAnswerValue, type SurveyQuestionModel } from '../lib/survey';

/**
 * 问卷题目渲染（FR-SUR-007 全部 7 种题型：说明/单选/多选/1-5/0-10/单行/多行）。
 * 受控组件：值由父级（问卷页）统一持有，key = question_code。
 * 可访问性：选择题用 fieldset/legend + 原生 radio/checkbox；错误 role=alert。
 */

/** 文本题答案长度上限（与服务端校验上限对齐，超出直接无法输入）。 */
const SURVEY_ANSWER_TEXT_MAX = 2000;
export function SurveyQuestionField({
  model,
  value,
  error,
  onChange,
}: {
  model: SurveyQuestionModel;
  value: SurveyAnswerValue | undefined;
  error?: string;
  onChange: (value: SurveyAnswerValue) => void;
}) {
  const autoId = useId();
  const groupName = `q-${model.questionCode}`;
  const requiredMark = model.required ? (
    <span className="cc-required" aria-hidden="true">
      *
    </span>
  ) : null;
  const sensitiveHint = model.isSensitive ? (
    <p className="cc-hint cc-hint-sensitive">敏感题目：普通导出与分析不包含本答案</p>
  ) : null;
  const errorBlock = error ? (
    <p className="cc-error" role="alert">
      {error}
    </p>
  ) : null;

  if (model.questionType === 'info') {
    return (
      <div className="cc-field cc-survey-info">
        <p className="cc-survey-info-text">{model.title}</p>
      </div>
    );
  }

  if (model.questionType === 'text_short' || model.questionType === 'text_long') {
    if (model.questionType === 'text_short') {
      return (
        <Input
          label={model.title}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          required={model.required}
          error={error}
          hint={model.isSensitive ? '敏感题目：普通导出与分析不包含本答案' : undefined}
          maxLength={SURVEY_ANSWER_TEXT_MAX}
        />
      );
    }
    const errorId = error ? `${groupName}-${autoId}-error` : undefined;
    return (
      <div className={`cc-field${error ? ' cc-field-error' : ''}`}>
        <label className="cc-label" htmlFor={`${groupName}-${autoId}`}>
          {model.title}
          {requiredMark}
        </label>
        <textarea
          id={`${groupName}-${autoId}`}
          className="cc-input cc-textarea"
          rows={4}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          maxLength={SURVEY_ANSWER_TEXT_MAX}
        />
        {sensitiveHint}
        {errorBlock}
      </div>
    );
  }

  // 单选 / 多选 / 量表：fieldset + 选项列表
  let options: Array<{ value: string; label: string }> = [];
  let inputType: 'radio' | 'checkbox' = 'radio';
  if (model.questionType === 'single_choice') {
    options = model.options.map((o) => ({ value: o.value, label: o.label }));
  } else if (model.questionType === 'multi_choice') {
    inputType = 'checkbox';
    options = model.options.map((o) => ({ value: o.value, label: o.label }));
  } else {
    const range = scaleRange(model.questionType)!;
    for (let i = range.min; i <= range.max; i += 1) {
      options.push({ value: String(i), label: String(i) });
    }
  }

  const selectedMulti = Array.isArray(value) ? value : [];
  const checkedValue = (opt: string): boolean => {
    if (model.questionType === 'multi_choice') return selectedMulti.includes(opt);
    if (model.questionType === 'scale_1_5' || model.questionType === 'scale_0_10') {
      return value === Number(opt);
    }
    return value === opt;
  };

  const handleChange = (opt: string, checked: boolean) => {
    if (model.questionType === 'multi_choice') {
      onChange(checked ? [...selectedMulti, opt] : selectedMulti.filter((v) => v !== opt));
    } else if (model.questionType === 'scale_1_5' || model.questionType === 'scale_0_10') {
      onChange(Number(opt));
    } else {
      onChange(opt);
    }
  };

  const layoutClass =
    model.questionType === 'scale_1_5' || model.questionType === 'scale_0_10'
      ? 'cc-choice-list cc-scale-list'
      : 'cc-choice-list';

  return (
    <fieldset
      className={`cc-field cc-fieldset${error ? ' cc-field-error' : ''}`}
      aria-invalid={error ? true : undefined}
    >
      <legend className="cc-label">
        {model.title}
        {requiredMark}
      </legend>
      {options.length === 0 ? (
        <p className="cc-hint">本题暂无可选选项，请联系机构管理员</p>
      ) : (
        <div className={layoutClass} role="group" aria-label={model.title}>
          {options.map((opt) => {
            const id = `${groupName}-${autoId}-${opt.value}`;
            return (
              <label key={opt.value} className="cc-choice" htmlFor={id}>
                <input
                  id={id}
                  type={inputType}
                  name={`${groupName}-${autoId}`}
                  value={opt.value}
                  checked={checkedValue(opt.value)}
                  onChange={(e) => handleChange(opt.value, e.target.checked)}
                />
                <span>{opt.label}</span>
              </label>
            );
          })}
        </div>
      )}
      {sensitiveHint}
      {errorBlock}
    </fieldset>
  );
}
