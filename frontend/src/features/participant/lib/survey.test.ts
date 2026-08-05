import { describe, expect, it } from 'vitest';
import type { SurveyQuestionRecord } from '../../../shared/api/types';
import {
  answersToMap,
  buildSurveyAnswersPayload,
  buildSurveyFormModel,
  isAnswerEmpty,
  scaleRange,
  validateQuestionAnswer,
  validateSurveyAnswers,
  type SurveyQuestionModel,
} from './survey';

/**
 * 问卷题型校验单测（FR-SUR-007/008；test-plan §2 表单组件）。
 * 覆盖 7 种题型的判空/必填/取值校验、载荷组装、答案还原。
 */

function question(partial: Partial<SurveyQuestionRecord>): SurveyQuestionRecord {
  return {
    id: 'q1',
    activity_survey_id: 'as1',
    question_code: 'Q1',
    source_type: 'standard',
    question_type: 'text_short',
    title: '题目',
    required: false,
    locked: false,
    is_sensitive: false,
    order_index: 1,
    created: '',
    updated: '',
    ...partial,
  };
}

function modelOf(partial: Partial<SurveyQuestionModel>): SurveyQuestionModel {
  return {
    id: 'q1',
    questionCode: 'Q1',
    questionType: 'text_short',
    title: '题目',
    required: true,
    locked: false,
    isSensitive: false,
    orderIndex: 1,
    options: [],
    ...partial,
  };
}

describe('buildSurveyFormModel', () => {
  it('按 order_index 升序并解析选择题选项', () => {
    const models = buildSurveyFormModel([
      question({ question_code: 'B', order_index: 2 }),
      question({
        question_code: 'A',
        order_index: 1,
        question_type: 'single_choice',
        options_json: [{ value: 'x', label: 'X' }],
      }),
    ]);
    expect(models.map((m) => m.questionCode)).toEqual(['A', 'B']);
    expect(models[0].options).toEqual([{ value: 'x', label: 'X' }]);
  });
});

describe('scaleRange 量表范围（FR-SUR-007）', () => {
  it('1-5 与 0-10 两种固定量表', () => {
    expect(scaleRange('scale_1_5')).toEqual({ min: 1, max: 5 });
    expect(scaleRange('scale_0_10')).toEqual({ min: 0, max: 10 });
    expect(scaleRange('text_short')).toBeNull();
  });
});

describe('isAnswerEmpty 判空口径', () => {
  it('undefined / 空白字符串 / 空数组为空；0 与 false 类有效值非空', () => {
    expect(isAnswerEmpty(undefined)).toBe(true);
    expect(isAnswerEmpty('  ')).toBe(true);
    expect(isAnswerEmpty([])).toBe(true);
    expect(isAnswerEmpty(0)).toBe(false); // 0-10 量表的 0 是有效答案
    expect(isAnswerEmpty('有内容')).toBe(false);
    expect(isAnswerEmpty(['a'])).toBe(false);
  });
});

describe('validateQuestionAnswer 各题型校验', () => {
  it('说明题无需作答永不报错（FR-SUR-007 info）', () => {
    const m = modelOf({ questionType: 'info', required: true });
    expect(validateQuestionAnswer(m, undefined)).toBeNull();
  });

  it('必填判空：各可作答题型统一文案', () => {
    for (const type of ['single_choice', 'multi_choice', 'scale_1_5', 'text_short', 'text_long'] as const) {
      const m = modelOf({ questionType: type });
      expect(validateQuestionAnswer(m, undefined)).toBe('本题为必答题');
    }
    const optional = modelOf({ required: false });
    expect(validateQuestionAnswer(optional, undefined)).toBeNull();
  });

  it('单选/多选：取值必须命中选项', () => {
    const single = modelOf({
      questionType: 'single_choice',
      options: [{ value: 'a', label: 'A' }],
    });
    expect(validateQuestionAnswer(single, 'zzz')).toBe('选项无效');
    expect(validateQuestionAnswer(single, 'a')).toBeNull();

    const multi = modelOf({
      questionType: 'multi_choice',
      options: [{ value: 'a', label: 'A' }],
    });
    expect(validateQuestionAnswer(multi, ['a', 'zzz'])).toBe('选项无效');
    expect(validateQuestionAnswer(multi, ['a'])).toBeNull();
  });

  it('1-5 量表：仅接受 1–5 整数', () => {
    const m = modelOf({ questionType: 'scale_1_5' });
    expect(validateQuestionAnswer(m, 0)).toContain('1–5');
    expect(validateQuestionAnswer(m, 6)).toContain('1–5');
    expect(validateQuestionAnswer(m, 2.5)).toContain('1–5');
    expect(validateQuestionAnswer(m, 3)).toBeNull();
  });

  it('0-10 量表：仅接受 0–10 整数（0 为有效值）', () => {
    const m = modelOf({ questionType: 'scale_0_10' });
    expect(validateQuestionAnswer(m, -1)).toContain('0–10');
    expect(validateQuestionAnswer(m, 11)).toContain('0–10');
    expect(validateQuestionAnswer(m, 0)).toBeNull();
    expect(validateQuestionAnswer(m, 10)).toBeNull();
  });
});

describe('validateSurveyAnswers 整卷校验', () => {
  it('聚合各题错误（key = question_code）', () => {
    const models = [
      modelOf({ questionCode: 'A' }),
      modelOf({ questionCode: 'B', required: false }),
    ];
    const errors = validateSurveyAnswers(models, { B: '已答' });
    expect(errors).toEqual({ A: '本题为必答题' });
  });
});

describe('buildSurveyAnswersPayload 载荷组装', () => {
  it('说明题与未作答题不下发，多选为数组，量表为数值', () => {
    const models = [
      modelOf({ questionCode: 'INFO', questionType: 'info', required: false }),
      modelOf({ questionCode: 'MOOD', questionType: 'single_choice', options: [{ value: 'g', label: '好' }] }),
      modelOf({ questionCode: 'SAT', questionType: 'scale_0_10', required: false }),
      modelOf({ questionCode: 'TAG', questionType: 'multi_choice', required: false, options: [{ value: 'a', label: 'A' }] }),
      modelOf({ questionCode: 'NOTE', questionType: 'text_long', required: false }),
    ];
    const payload = buildSurveyAnswersPayload(models, {
      INFO: '不应出现',
      MOOD: 'g',
      SAT: 0,
      TAG: ['a'],
      NOTE: '   ',
    });
    expect(payload).toEqual([
      { question_code: 'MOOD', value: 'g' },
      { question_code: 'SAT', value: 0 },
      { question_code: 'TAG', value: ['a'] },
    ]);
  });
});

describe('answersToMap 答案还原（草稿预填 / 只读展示）', () => {
  it('string/number/array 还原为表单值，其它形态跳过', () => {
    const map = answersToMap([
      { question_code: 'A', value_json: '文本' },
      { question_code: 'B', value_json: 5 },
      { question_code: 'C', value_json: ['x', 'y'] },
      { question_code: 'D', value_json: { nested: true } },
      { question_code: 'E', value_json: null },
    ]);
    expect(map).toEqual({ A: '文本', B: 5, C: ['x', 'y'] });
  });
});
