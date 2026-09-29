import { describe, expect, it } from 'vitest';
import type { SurveyQuestionRecord } from '../../../shared/api/types';
import {
  answersToMap,
  buildSurveyAnswersPayload,
  buildSurveyFormModel,
  isAnswerEmpty,
  isSurveyQuestionVisible,
  pruneHiddenSurveyAnswers,
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

  it('解析已知量表、编号及条件配置，忽略未知正则', () => {
    const models = buildSurveyFormModel([
      question({ question_code: 'SCALE', question_type: 'scale_1_5', validation_json: { labels: { 1: '完全没有', 5: '非常充实' } } }),
      question({ question_code: 'TAG', validation_json: { pattern: '^C[0-9]+$' } }),
      question({ question_code: 'UNKNOWN', validation_json: { pattern: '.*' } }),
    ]);
    expect(models[0].validation?.labels).toEqual({ 1: '完全没有', 5: '非常充实' });
    expect(models[1].validation?.pattern).toBe('^C[0-9]+$');
    expect(models[2].validation?.pattern).toBeUndefined();
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

  it('Listener Tag 仅接受 C 后接数字', () => {
    const m = modelOf({ validation: { pattern: '^C[0-9]+$' } });
    expect(validateQuestionAnswer(m, 'C07')).toBeNull();
    expect(validateQuestionAnswer(m, 'C')).toContain('如 C07');
    expect(validateQuestionAnswer(m, 'c07')).toContain('如 C07');
    expect(validateQuestionAnswer(m, 'C07a')).toContain('如 C07');
  });
});

describe('Q21 条件补充项与互斥答案', () => {
  const models = buildSurveyFormModel([
    question({ question_code: 'CPOST_Q21', question_type: 'multi_choice', required: true,
      options_json: [{ value: 'other', label: '其他' }, { value: 'community', label: '社区活动' }, { value: 'nothing_for_now', label: '暂时没有' }],
      validation_json: { exclusive_values: ['nothing_for_now'] }, order_index: 1 }),
    question({ question_code: 'CPOST_Q21_OTHER', question_type: 'text_long', required: true,
      validation_json: { show_when: { question_code: 'CPOST_Q21', value: 'other' } }, order_index: 2 }),
  ]);

  it('other 入选才显示且必答，隐藏答案不会校验或提交', () => {
    expect(isSurveyQuestionVisible(models[1], models, { CPOST_Q21: ['other'] })).toBe(true);
    expect(validateSurveyAnswers(models, { CPOST_Q21: ['other'] }).CPOST_Q21_OTHER).toBe('本题为必答题');
    const stale = { CPOST_Q21: ['community'], CPOST_Q21_OTHER: '旧补充' };
    expect(isSurveyQuestionVisible(models[1], models, stale)).toBe(false);
    expect(pruneHiddenSurveyAnswers(models, stale)).toEqual({ CPOST_Q21: ['community'] });
    expect(validateSurveyAnswers(models, stale)).toEqual({});
    expect(buildSurveyAnswersPayload(models, stale)).toEqual([{ question_code: 'CPOST_Q21', value: ['community'] }]);
  });

  it('互斥选项与其它选项混选时阻止提交', () => {
    expect(validateQuestionAnswer(models[0], ['nothing_for_now', 'other'])).toContain('互斥选项');
    expect(validateQuestionAnswer(models[0], ['nothing_for_now'])).toBeNull();
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
