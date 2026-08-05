import type { QuestionType } from '../../../shared/api/types';
import type { PublicSurveyQuestion, SurveyAnswerInput } from '../api';
import { parseChoiceOptions, type ChoiceOption } from './choiceOptions';

/**
 * 问卷填写逻辑（FR-SUR-006/007/008）。
 * 7 种题型（说明/单选/多选/1-5/0-10/单行/多行）的渲染模型、必填与取值校验、
 * 草稿/提交载荷组装。前端校验仅作体验层提示，资格与锁定由服务端强制。
 */

/** 问卷题目渲染模型。 */
export interface SurveyQuestionModel {
  id: string;
  questionCode: string;
  questionType: QuestionType;
  title: string;
  required: boolean;
  locked: boolean;
  /** 敏感题：普通导出过滤（FR-SUR-012）；填写页给出提示。 */
  isSensitive: boolean;
  orderIndex: number;
  options: ChoiceOption[];
}

/** 答卷表单值（key = question_code）：单选/文本为 string，多选为 string[]，量表为 number。 */
export type SurveyAnswerValue = string | number | string[];
export type SurveyAnswerMap = Record<string, SurveyAnswerValue>;

/** 由题目记录构建渲染模型，按 order_index 升序（服务端通常已排序，此处兜底）。 */
export function buildSurveyFormModel(questions: PublicSurveyQuestion[]): SurveyQuestionModel[] {
  return [...questions]
    .sort((a, b) => a.order_index - b.order_index)
    .map((q) => ({
      id: q.id,
      questionCode: q.question_code,
      questionType: q.question_type,
      title: q.title,
      required: q.required,
      locked: q.locked,
      isSensitive: q.is_sensitive,
      orderIndex: q.order_index,
      options:
        q.question_type === 'single_choice' || q.question_type === 'multi_choice'
          ? parseChoiceOptions(q.options_json)
          : [],
    }));
}

/** 量表题型取值范围（FR-SUR-007：1-5 / 0-10 两种固定量表）。 */
export function scaleRange(type: QuestionType): { min: number; max: number } | null {
  if (type === 'scale_1_5') return { min: 1, max: 5 };
  if (type === 'scale_0_10') return { min: 0, max: 10 };
  return null;
}

/** 说明题不需要作答，不进入校验与提交。 */
export function isAnswerable(type: QuestionType): boolean {
  return type !== 'info';
}

/** 答案是否为空（必填校验的统一判空口径）。 */
export function isAnswerEmpty(value: SurveyAnswerValue | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** 单题校验：返回 null 表示通过，否则为错误文案。 */
export function validateQuestionAnswer(
  model: SurveyQuestionModel,
  value: SurveyAnswerValue | undefined,
): string | null {
  if (!isAnswerable(model.questionType)) return null;
  if (isAnswerEmpty(value)) {
    return model.required ? '本题为必答题' : null;
  }
  switch (model.questionType) {
    case 'single_choice':
      return model.options.some((o) => o.value === value) ? null : '选项无效';
    case 'multi_choice': {
      if (!Array.isArray(value)) return '选项无效';
      return value.every((v) => model.options.some((o) => o.value === v)) ? null : '选项无效';
    }
    case 'scale_1_5':
    case 'scale_0_10': {
      const range = scaleRange(model.questionType)!;
      const ok =
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= range.min &&
        value <= range.max;
      return ok ? null : `请选择 ${range.min}–${range.max} 之间的评分`;
    }
    case 'text_short':
    case 'text_long':
      return typeof value === 'string' ? null : '答案格式不正确';
    case 'info':
      return null;
  }
}

/** 整卷校验（正式提交前调用；草稿保存不校验）。key = question_code。 */
export function validateSurveyAnswers(
  models: SurveyQuestionModel[],
  answers: SurveyAnswerMap,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const model of models) {
    const err = validateQuestionAnswer(model, answers[model.questionCode]);
    if (err) errors[model.questionCode] = err;
  }
  return errors;
}

/**
 * 组装草稿/提交载荷（answers: [{ question_code, value }]）。
 * 说明题与未作答题不下发；多选用标准 JSON 数组（PRD §10.3）。
 */
export function buildSurveyAnswersPayload(
  models: SurveyQuestionModel[],
  answers: SurveyAnswerMap,
): SurveyAnswerInput[] {
  const payload: SurveyAnswerInput[] = [];
  for (const model of models) {
    if (!isAnswerable(model.questionType)) continue;
    const value = answers[model.questionCode];
    if (isAnswerEmpty(value)) continue;
    payload.push({ question_code: model.questionCode, value });
  }
  return payload;
}

/**
 * 由服务端下发的答案行还原表单值，用于草稿预填与只读展示。
 * 出参契约为 { question_code, value }（已实跑核对）；兼容历史 value_json 命名。
 */
export function answersToMap(
  items: Array<{ question_code: string; value?: unknown; value_json?: unknown }>,
): SurveyAnswerMap {
  const map: SurveyAnswerMap = {};
  for (const item of items) {
    const v = item.value !== undefined ? item.value : item.value_json;
    if (typeof v === 'string' || typeof v === 'number' || Array.isArray(v)) {
      map[item.question_code] = v as SurveyAnswerValue;
    }
  }
  return map;
}
