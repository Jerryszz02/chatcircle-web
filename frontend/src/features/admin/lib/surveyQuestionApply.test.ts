import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SurveyQuestionRecord } from '../../../shared/api/types';
import {
  emptyQuestionDraft,
  type TemplateQuestionDraft,
} from '../../../shared/survey/questionDrafts';
import { planOrderUpdates, planQuestionChanges } from './surveyQuestionApply';

/**
 * 问卷题目编辑提交适配器单测（test-plan §2 L1：纯函数决策层）。
 * 口径依据：surveys.pb.js 守卫（创建必须 custom + 非锁定、锁定题任何字段不可改、
 * question_code 不可变）、order_index 从 1 起、锁定题为排序锚点。
 */

let idSeq = 0;

function makeQuestion(overrides: Partial<SurveyQuestionRecord> = {}): SurveyQuestionRecord {
  idSeq += 1;
  return {
    id: `rec_${idSeq}`,
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    activity_survey_id: 'survey_1',
    question_code: `STD_${idSeq}`,
    source_type: 'standard',
    question_type: 'text_short',
    title: '题目',
    required: false,
    locked: false,
    is_sensitive: false,
    order_index: idSeq,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<TemplateQuestionDraft> = {}): TemplateQuestionDraft {
  return { ...emptyQuestionDraft(), title: '新题', ...overrides };
}

/** 与既有行对齐的草稿（code 指向既有行；字段默认与行一致 = 无变化）。 */
function draftOf(
  row: SurveyQuestionRecord,
  overrides: Partial<TemplateQuestionDraft> = {},
): TemplateQuestionDraft {
  return makeDraft({
    question_code: row.question_code,
    question_type: row.question_type,
    title: row.title,
    required: row.required,
    locked: row.locked,
    is_sensitive: row.is_sensitive,
    fromPublished: true,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('planQuestionChanges：新建自定义题（create）', () => {
  it('code 为空的新草稿生成 create：自动 code、custom、非锁定、临时 order_index 从末尾递增', () => {
    const existing = [makeQuestion({ order_index: 1 }), makeQuestion({ order_index: 2 })];
    const drafts = [makeDraft({ title: '  附加题  ' }), makeDraft({ title: '附加题二' })];
    const { creates, updates } = planQuestionChanges(drafts, existing, 'survey_1');

    expect(updates).toEqual([]);
    expect(creates).toHaveLength(2);
    for (const [i, create] of creates.entries()) {
      expect(create.activity_survey_id).toBe('survey_1');
      expect(create.question_code).toMatch(/^CUS_[0-9A-Z]+(_\d+)?$/);
      expect(create.source_type).toBe('custom');
      expect(create.locked).toBe(false);
      expect(create.order_index).toBe(3 + i); // max(既有 order_index)+1 起递增
    }
    expect(creates[0].title).toBe('附加题'); // trim
    expect(creates[0].question_code).not.toBe(creates[1].question_code);
  });

  it('无既有题时临时 order_index 从 1 起；选择题选项 trim 写入 options_json，非选择题为 undefined', () => {
    const choice = makeDraft({
      question_type: 'single_choice',
      options: [{ value: ' a ', label: ' A ' }],
    });
    const text = makeDraft({ question_type: 'text_short' });
    const { creates } = planQuestionChanges([choice, text], [], 'survey_1');

    expect(creates[0].order_index).toBe(1);
    expect(creates[0].options_json).toEqual({ options: [{ value: 'a', label: 'A' }] });
    expect(creates[1].order_index).toBe(2);
    expect(creates[1].options_json).toBeUndefined();
  });

  it('code 非空但不属于任何既有行的草稿同样视为新题（code 自动生成）', () => {
    const { creates, updates } = planQuestionChanges(
      [makeDraft({ question_code: 'GHOST' })],
      [],
      'survey_1',
    );
    expect(updates).toEqual([]);
    expect(creates).toHaveLength(1);
    expect(creates[0].question_code).toMatch(/^CUS_[0-9A-Z]+(_\d+)?$/);
  });

  it('自动 code 与既有 code 或本批次冲突时追加 _2、_3 后缀', () => {
    // 固定时间戳使自动 code 可预测：base = (0).toString(36).toUpperCase() = '0'
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const existing = [makeQuestion({ question_code: 'CUS_0' })];
    const drafts = [draftOf(existing[0]), makeDraft(), makeDraft()];
    const { creates } = planQuestionChanges(drafts, existing, 'survey_1');

    expect(creates.map((c) => c.question_code)).toEqual(['CUS_0_2', 'CUS_0_3']);
  });
});

describe('planQuestionChanges：已有题更新（update）', () => {
  it('非锁定题字段变化时生成 update（data 含 title/required/is_sensitive/options_json 四项）', () => {
    const row = makeQuestion({ title: '旧题干', required: false, is_sensitive: false });
    const draft = draftOf(row, { title: '  新题干  ', required: true, is_sensitive: true });
    const { creates, updates } = planQuestionChanges([draft], [row], 'survey_1');

    expect(creates).toEqual([]);
    expect(updates).toEqual([
      {
        id: row.id,
        data: {
          title: '新题干',
          required: true,
          is_sensitive: true,
          options_json: undefined,
        },
      },
    ]);
  });

  it('选择题选项变化时生成 update；选项一致（含既有 options_json 解析）不生成', () => {
    const row = makeQuestion({
      question_type: 'single_choice',
      options_json: { options: [{ value: 'a', label: 'A' }] },
    });
    const changed = planQuestionChanges(
      [
        draftOf(row, {
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        }),
      ],
      [row],
      'survey_1',
    );
    expect(changed.updates).toHaveLength(1);
    expect(changed.updates[0].data.options_json).toEqual({
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });

    const unchanged = planQuestionChanges(
      [draftOf(row, { options: [{ value: 'a', label: 'A' }] })],
      [row],
      'survey_1',
    );
    expect(unchanged.updates).toEqual([]);
    expect(unchanged.creates).toEqual([]);
  });

  it('四个字段均无变化时不生成 update', () => {
    const row = makeQuestion({ title: '题目', required: true, is_sensitive: true });
    const { creates, updates } = planQuestionChanges([draftOf(row)], [row], 'survey_1');
    expect(creates).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('锁定题任何字段变化都不生成 update（后端 403，计划阶段直接跳过）', () => {
    const row = makeQuestion({ locked: true, title: '锁定题' });
    const draft = draftOf(row, { title: '试图修改', required: true });
    const { creates, updates } = planQuestionChanges([draft], [row], 'survey_1');
    expect(creates).toEqual([]);
    expect(updates).toEqual([]);
  });
});

describe('planOrderUpdates：槽位重排（锁定题为锚点）', () => {
  it('锁定题在中间时，自定义题只在非锁定槽位内换序，锁定行不产生 update', () => {
    const a = makeQuestion({ question_code: 'A', order_index: 1 });
    const locked = makeQuestion({ question_code: 'L', order_index: 2, locked: true });
    const b = makeQuestion({ question_code: 'B', order_index: 3 });
    const rows = [a, locked, b];
    // 草稿顺序 B → L → A：B/A 跨过锁定题交换位置
    const drafts = [draftOf(b), draftOf(locked), draftOf(a)];

    const updates = planOrderUpdates(drafts, rows);
    expect(updates).toEqual([
      { id: b.id, order_index: 1 },
      { id: a.id, order_index: 3 },
    ]);
    expect(updates.some((u) => u.id === locked.id)).toBe(false);
  });

  it('草稿顺序与现状一致时不生成任何 update', () => {
    const a = makeQuestion({ question_code: 'A', order_index: 1 });
    const locked = makeQuestion({ question_code: 'L', order_index: 2, locked: true });
    const b = makeQuestion({ question_code: 'B', order_index: 3 });
    const drafts = [draftOf(a), draftOf(locked), draftOf(b)];

    expect(planOrderUpdates(drafts, [a, locked, b])).toEqual([]);
  });

  it('新建题排在末尾时保留其临时末尾槽位（无 update）；插入中间时按槽位顺移', () => {
    const a = makeQuestion({ question_code: 'A', order_index: 1 });
    const b = makeQuestion({ question_code: 'B', order_index: 2 });
    // 新建行已创建，拿到临时 order_index 3
    const created = makeQuestion({
      question_code: 'CUS_NEW',
      order_index: 3,
      source_type: 'custom',
    });
    const newDraft = makeDraft({ question_code: 'CUS_NEW' });

    // 末尾：1/2/3 各就各位 → 无 update
    expect(planOrderUpdates([draftOf(a), draftOf(b), newDraft], [a, b, created])).toEqual([]);

    // 中间：A=1 不变，新题拿槽位 2，B 顺移到槽位 3
    expect(planOrderUpdates([draftOf(a), newDraft, draftOf(b)], [a, b, created])).toEqual([
      { id: created.id, order_index: 2 },
      { id: b.id, order_index: 3 },
    ]);
  });
});
