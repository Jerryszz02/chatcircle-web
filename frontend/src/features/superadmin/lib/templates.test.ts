import { describe, expect, it } from 'vitest';
import {
  draftsFromSchema,
  emptyQuestionDraft,
  schemaFromDrafts,
  validateQuestionDrafts,
  type TemplateQuestionDraft,
} from './templates';

function makeDraft(overrides: Partial<TemplateQuestionDraft> = {}): TemplateQuestionDraft {
  return {
    ...emptyQuestionDraft(),
    question_code: 'Q1',
    title: '题目一',
    ...overrides,
  };
}

describe('draftsFromSchema（解析既有版本，双命名兼容）', () => {
  it('解析 options/order/validation 旧命名并标记 fromPublished', () => {
    const drafts = draftsFromSchema({
      questions: [
        {
          question_code: 'SAT',
          question_type: 'single_choice',
          title: '满意度',
          required: true,
          order: 5,
          options: [{ value: 'good', label: '满意' }],
          validation: { min: 1 },
        },
      ],
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      question_code: 'SAT',
      question_type: 'single_choice',
      required: true,
      options: [{ value: 'good', label: '满意' }],
      validation_json: { min: 1 },
      fromPublished: true,
    });
  });

  it('解析 options_json 新命名；非法题型与结构不符的项跳过', () => {
    const drafts = draftsFromSchema({
      questions: [
        {
          question_code: 'MOOD',
          question_type: 'scale_1_5',
          title: '情绪',
          options_json: { options: [{ value: '1', label: '差' }] },
        },
        { question_code: 'BAD', question_type: 'dropdown', title: '非法题型' },
        'junk',
      ],
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].options).toEqual([{ value: '1', label: '差' }]);
  });

  it('非对象/无 questions 返回空数组', () => {
    expect(draftsFromSchema(null)).toEqual([]);
    expect(draftsFromSchema({})).toEqual([]);
  });
});

describe('schemaFromDrafts（规范化产出）', () => {
  it('order_index 按数组顺序 0 起始；选择题输出 options_json；透传 validation_json', () => {
    const schema = schemaFromDrafts([
      makeDraft({ question_code: 'A', options: [{ value: ' x ', label: ' y ' }], question_type: 'multi_choice' }),
      makeDraft({ question_code: 'B', question_type: 'text_long', validation_json: { max: 200 } }),
    ]);
    expect(schema.questions[0]).toEqual({
      question_code: 'A',
      question_type: 'multi_choice',
      title: '题目一',
      required: false,
      locked: false,
      is_sensitive: false,
      order_index: 0,
      options_json: { options: [{ value: 'x', label: 'y' }] },
    });
    expect(schema.questions[1]).toMatchObject({ order_index: 1, validation_json: { max: 200 } });
    expect(schema.questions[1]).not.toHaveProperty('options_json');
  });

  it('与 draftsFromSchema 往返无损（核心字段）', () => {
    const original = [
      makeDraft({
        question_code: 'MOOD',
        question_type: 'scale_1_5',
        required: true,
        locked: true,
        is_sensitive: true,
      }),
    ];
    const roundTripped = draftsFromSchema(schemaFromDrafts(original));
    expect(roundTripped[0]).toMatchObject({
      question_code: 'MOOD',
      question_type: 'scale_1_5',
      required: true,
      locked: true,
      is_sensitive: true,
    });
  });
});

describe('validateQuestionDrafts（与后端模板端点规则对齐）', () => {
  it('空列表报错', () => {
    expect(validateQuestionDrafts([])).toContain('至少需要 1 道题目');
  });

  it('question_code 必填/格式/唯一', () => {
    expect(validateQuestionDrafts([makeDraft({ question_code: ' ' })])).toContain(
      'question_code 必填',
    );
    expect(validateQuestionDrafts([makeDraft({ question_code: 'bad-code' })])).toContain(
      '仅允许字母/数字/下划线',
    );
    expect(
      validateQuestionDrafts([makeDraft({ question_code: 'Q1' }), makeDraft({ question_code: 'Q1' })]),
    ).toContain('重复');
  });

  it('title 必填', () => {
    expect(validateQuestionDrafts([makeDraft({ title: '' })])).toContain('title 必填');
  });

  it('选择题必须有选项、选项 value/label 必填且不重复', () => {
    expect(
      validateQuestionDrafts([makeDraft({ question_type: 'single_choice', options: [] })]),
    ).toContain('至少需 1 个选项');
    expect(
      validateQuestionDrafts([
        makeDraft({ question_type: 'single_choice', options: [{ value: '', label: 'x' }] }),
      ]),
    ).toContain('value 与 label 必填');
    expect(
      validateQuestionDrafts([
        makeDraft({
          question_type: 'single_choice',
          options: [
            { value: 'a', label: '甲' },
            { value: 'a', label: '乙' },
          ],
        }),
      ]),
    ).toContain('选项 value 重复');
  });

  it('合法草稿通过', () => {
    expect(
      validateQuestionDrafts([
        makeDraft({ question_type: 'single_choice', options: [{ value: 'a', label: '甲' }] }),
      ]),
    ).toBeNull();
  });
});
