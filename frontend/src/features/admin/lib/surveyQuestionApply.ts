import type { QuestionType, SurveyQuestionRecord } from '../../../shared/api/types';
import {
  CHOICE_QUESTION_TYPES,
  type TemplateQuestionDraft,
} from '../../../shared/survey/questionDrafts';
import { adminCollections } from './api';

/**
 * 问卷题目编辑提交适配器（SurveyQuestionEditor 的落库层）。
 *
 * 把编辑器草稿对齐到 survey_questions 集合，受后端守卫约束（surveys.pb.js）：
 * - 创建必须 source_type='custom' 且 locked=false，question_code 自动生成后不可变；
 * - 锁定题（locked=true）任何字段都不可改——计划阶段直接跳过；
 * - 排序用「槽位重排」：非锁定行的 order_index 集合为槽位，按草稿顺序重新分配，
 *   锁定行的 order_index 绝不动（其位置即排序锚点）。
 *
 * planQuestionChanges / planOrderUpdates 为纯函数（可单测）；applyQuestionChanges
 * 按 creates → updates → 排序 顺序执行，任何失败原样抛错（由编辑器内联展示）。
 */

/** 新建自定义题的 create 数据（order_index 为临时值，随后由槽位重排修正）。 */
export interface QuestionCreateData {
  activity_survey_id: string;
  question_code: string;
  source_type: 'custom';
  question_type: QuestionType;
  title: string;
  required: boolean;
  is_sensitive: boolean;
  options_json?: { options: { value: string; label: string }[] };
  locked: false;
  order_index: number;
}

/** 已有非锁定题的 update 数据（仅这四个字段允许机构修改，全量四个简单可靠）。 */
export interface QuestionUpdateData {
  title: string;
  required: boolean;
  is_sensitive: boolean;
  options_json?: { options: { value: string; label: string }[] };
}

export interface QuestionChangePlan {
  creates: QuestionCreateData[];
  updates: { id: string; data: QuestionUpdateData }[];
}

/** 草稿的选择题选项（value/label trim 后写入 options_json；非选择题为 undefined）。 */
function optionsFromDraft(
  d: TemplateQuestionDraft,
): { options: { value: string; label: string }[] } | undefined {
  if (!CHOICE_QUESTION_TYPES.includes(d.question_type)) return undefined;
  return {
    options: d.options.map((o) => ({ value: o.value.trim(), label: o.label.trim() })),
  };
}

/** 防御式解析记录上的 options_json（可能为 null 或结构不符），用于变化检测。 */
function normalizeOptions(
  optionsJson: unknown,
): { options: { value: string; label: string }[] } | undefined {
  if (typeof optionsJson !== 'object' || optionsJson === null) return undefined;
  const raw = (optionsJson as { options?: unknown }).options;
  if (!Array.isArray(raw)) return undefined;
  const options = raw
    .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
    .map((o) => ({
      value: typeof o.value === 'string' ? o.value : String(o.value ?? ''),
      label: typeof o.label === 'string' ? o.label : String(o.label ?? ''),
    }));
  return options.length > 0 ? { options } : undefined;
}

/**
 * 生成 count 个不冲突的自定义 question_code：CUS_<时间戳 base36 大写>，
 * 与既有 code 或本批次已生成 code 冲突时追加 _2、_3 等。taken 会被就地占用。
 */
function generateCodes(count: number, taken: Set<string>): string[] {
  const base = `CUS_${Date.now().toString(36).toUpperCase()}`;
  const codes: string[] = [];
  let suffix = 0;
  while (codes.length < count) {
    suffix += 1;
    const candidate = suffix === 1 ? base : `${base}_${suffix}`;
    if (taken.has(candidate)) continue;
    codes.push(candidate);
    taken.add(candidate);
  }
  return codes;
}

/** 草稿是否为「新题」（code 为空或不属于任何既有行）。 */
function isNewDraft(d: TemplateQuestionDraft, existingCodes: Set<string>): boolean {
  const code = d.question_code.trim();
  return !code || !existingCodes.has(code);
}

/**
 * 按 question_code 对齐草稿与既有题目，计算创建/更新计划：
 * - 新草稿 → create（自动生成 code、source_type='custom'、locked=false，
 *   order_index 取 max(既有 order_index, 0)+1 起按创建顺序递增的临时值）；
 * - 已存在且未锁定 → 仅当 title/required/is_sensitive/options_json 有变化时生成 update；
 * - 已存在且锁定 → 跳过（后端对锁定题任何字段修改均 403）。
 */
export function planQuestionChanges(
  drafts: TemplateQuestionDraft[],
  existing: SurveyQuestionRecord[],
  surveyId: string,
): QuestionChangePlan {
  const existingByCode = new Map(existing.map((q) => [q.question_code, q]));
  const taken = new Set(existing.map((q) => q.question_code));
  const newDrafts = drafts.filter((d) => isNewDraft(d, taken));
  // 批量生成并占用本批次 code，再按草稿顺序分配
  const generatedCodes = generateCodes(newDrafts.length, taken);
  const codeByKey = new Map(newDrafts.map((d, i) => [d.key, generatedCodes[i]]));

  const creates: QuestionCreateData[] = [];
  const updates: { id: string; data: QuestionUpdateData }[] = [];
  let nextOrderIndex = Math.max(0, ...existing.map((q) => q.order_index)) + 1;

  for (const d of drafts) {
    const generated = codeByKey.get(d.key);
    if (generated !== undefined) {
      creates.push({
        activity_survey_id: surveyId,
        question_code: generated,
        source_type: 'custom',
        question_type: d.question_type,
        title: d.title.trim(),
        required: d.required,
        is_sensitive: d.is_sensitive,
        options_json: optionsFromDraft(d),
        locked: false,
        order_index: nextOrderIndex,
      });
      nextOrderIndex += 1;
      continue;
    }
    const row = existingByCode.get(d.question_code.trim());
    if (!row || row.locked) continue;
    const data: QuestionUpdateData = {
      title: d.title.trim(),
      required: d.required,
      is_sensitive: d.is_sensitive,
      options_json: optionsFromDraft(d),
    };
    const unchanged =
      row.title === data.title &&
      row.required === data.required &&
      row.is_sensitive === data.is_sensitive &&
      JSON.stringify(normalizeOptions(row.options_json) ?? null) ===
        JSON.stringify(data.options_json ?? null);
    if (!unchanged) updates.push({ id: row.id, data });
  }
  return { creates, updates };
}

/**
 * 槽位重排：allRows（既有行 + 新建行）中所有 locked=false 行的 order_index
 * 排序后为槽位列表；按 finalDrafts 顺序遍历非锁定草稿（按 code 找行）依次分配
 * 槽位值，与当前值不同才生成 { id, order_index }。锁定行的 order_index 绝不动。
 * finalDrafts 中新草稿须已回填创建时生成的 question_code。
 */
export function planOrderUpdates(
  finalDrafts: TemplateQuestionDraft[],
  allRows: SurveyQuestionRecord[],
): { id: string; order_index: number }[] {
  const rowByCode = new Map(allRows.map((r) => [r.question_code, r]));
  const slots = allRows
    .filter((r) => !r.locked)
    .map((r) => r.order_index)
    .sort((a, b) => a - b);
  const updates: { id: string; order_index: number }[] = [];
  let slotIndex = 0;
  for (const d of finalDrafts) {
    const row = rowByCode.get(d.question_code.trim());
    if (!row || row.locked) continue;
    const slot = slots[slotIndex];
    slotIndex += 1;
    // 防御：槽位耗尽（草稿多于非锁定行，正常流程不会发生）时停止分配
    if (slot === undefined) break;
    if (row.order_index !== slot) updates.push({ id: row.id, order_index: slot });
  }
  return updates;
}

/**
 * 执行题目变更：creates（收集返回行）→ updates → 用 既有行+新建行 做槽位重排。
 * 任何失败原样抛错（调用方/编辑器内联展示）。
 */
export async function applyQuestionChanges(
  surveyId: string,
  drafts: TemplateQuestionDraft[],
  existing: SurveyQuestionRecord[],
): Promise<void> {
  const cc = adminCollections().surveyQuestions;
  const { creates, updates } = planQuestionChanges(drafts, existing, surveyId);
  const createdRows: SurveyQuestionRecord[] = [];
  for (const data of creates) {
    createdRows.push(await cc.create(data));
  }
  for (const u of updates) {
    await cc.update(u.id, u.data);
  }
  // 新草稿按创建顺序回填自动生成的 question_code，供槽位重排按 code 对齐
  const existingCodes = new Set(existing.map((q) => q.question_code));
  const createdQueue = [...createdRows];
  const codedDrafts = drafts.map((d) => {
    if (!isNewDraft(d, existingCodes)) return d;
    const row = createdQueue.shift();
    return row ? { ...d, question_code: row.question_code } : d;
  });
  const orderUpdates = planOrderUpdates(codedDrafts, [...existing, ...createdRows]);
  for (const o of orderUpdates) {
    await cc.update(o.id, { order_index: o.order_index });
  }
}
