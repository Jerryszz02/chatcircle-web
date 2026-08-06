/**
 * 可视化问卷题目编辑器的草稿模型（超管端 TemplateSchemaEditor 与管理端
 * SurveyQuestionEditor 共用；原 superadmin/lib/templates 后半部分，原样下沉）。
 *
 * draftsFromSchema 解析既有题目定义（兼容 options/options_json、order/order_index、
 * validation/validation_json 双命名，与 surveys.pb.js 物化层契约一致；也可直接解析
 * `{ questions: survey_questions 行数组 }`，字段同名兼容），
 * schemaFromDrafts 产出规范化 schema（options_json/order_index/validation_json，
 * order_index 按数组顺序 0 起始生成，物化时后端 +1），
 * validateQuestionDrafts 与服务端 super.pb.js 模板端点的校验规则逐条对齐。
 */
import type { QuestionType } from '../api/types';

/** 选择题选项草稿。 */
export interface TemplateOptionDraft {
  value: string;
  label: string;
}

/** 题目草稿（编辑器内模型；提交时经 schemaFromDrafts 规范化）。 */
export interface TemplateQuestionDraft {
  /** 编辑器内稳定 key（React 列表用，不写入 schema）。 */
  key: string;
  question_code: string;
  question_type: QuestionType;
  title: string;
  required: boolean;
  /** 锁定核心题：机构不能修改或删除（FR-SUR-001）；仅超管端可编辑此标记。 */
  locked: boolean;
  /** 敏感题：普通导出按此过滤（FR-SUR-012）。 */
  is_sensitive: boolean;
  /** 选择题选项；其他题型为空数组。 */
  options: TemplateOptionDraft[];
  /** 高级校验定义（原样透传，可选）。 */
  validation_json?: Record<string, unknown>;
  /**
   * 是否从已发布版本带入：带入题的 question_code 不可改（PRD §8.3 稳定机器字段，
   * 统计/导出口径依赖跨版本一致），题型亦不可改（与机构端编辑器约定一致）。
   */
  fromPublished: boolean;
}

/** 七题型枚举（FR-SUR-007，与 shared/api/types 的 QuestionType 一致）。 */
export const TEMPLATE_QUESTION_TYPES: QuestionType[] = [
  'info',
  'single_choice',
  'multi_choice',
  'scale_1_5',
  'scale_0_10',
  'text_short',
  'text_long',
];

/** 选择题题型（必须有选项）。 */
export const CHOICE_QUESTION_TYPES: QuestionType[] = ['single_choice', 'multi_choice'];

let draftKeySeq = 0;

/** 生成编辑器内唯一 key。 */
export function newDraftKey(): string {
  draftKeySeq += 1;
  return `q_${Date.now().toString(36)}_${draftKeySeq}`;
}

/** 新建空白题目草稿。 */
export function emptyQuestionDraft(): TemplateQuestionDraft {
  return {
    key: newDraftKey(),
    question_code: '',
    question_type: 'text_short',
    title: '',
    required: false,
    locked: false,
    is_sensitive: false,
    options: [],
    fromPublished: false,
  };
}

/** 从 schema_json 解析题目草稿（防御式；双命名兼容；解析不到的项跳过）。 */
export function draftsFromSchema(schema: unknown): TemplateQuestionDraft[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const questions = (schema as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  const drafts: TemplateQuestionDraft[] = [];
  for (const raw of questions) {
    if (typeof raw !== 'object' || raw === null) continue;
    const q = raw as Record<string, unknown>;
    const type = q.question_type as QuestionType;
    if (!TEMPLATE_QUESTION_TYPES.includes(type)) continue;
    let options: TemplateOptionDraft[] = [];
    const rawOptions =
      typeof q.options_json === 'object' && q.options_json !== null
        ? (q.options_json as { options?: unknown }).options
        : q.options;
    if (Array.isArray(rawOptions)) {
      options = rawOptions
        .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
        .map((o) => ({
          value: typeof o.value === 'string' ? o.value : String(o.value ?? ''),
          label: typeof o.label === 'string' ? o.label : String(o.label ?? ''),
        }));
    }
    const validation = q.validation_json !== undefined ? q.validation_json : q.validation;
    drafts.push({
      key: newDraftKey(),
      question_code: typeof q.question_code === 'string' ? q.question_code : '',
      question_type: type,
      title: typeof q.title === 'string' ? q.title : '',
      required: q.required === true,
      locked: q.locked === true,
      is_sensitive: q.is_sensitive === true,
      options,
      ...(validation && typeof validation === 'object' && !Array.isArray(validation)
        ? { validation_json: validation as Record<string, unknown> }
        : {}),
      fromPublished: true,
    });
  }
  return drafts;
}

/** 草稿 → 规范化 schema_json（与后端模板端点的规范化规则一致）。 */
export function schemaFromDrafts(drafts: TemplateQuestionDraft[]): {
  questions: Record<string, unknown>[];
} {
  return {
    questions: drafts.map((d, i) => {
      const q: Record<string, unknown> = {
        question_code: d.question_code.trim(),
        question_type: d.question_type,
        title: d.title.trim(),
        required: d.required,
        locked: d.locked,
        is_sensitive: d.is_sensitive,
        order_index: i,
      };
      if (CHOICE_QUESTION_TYPES.includes(d.question_type)) {
        q.options_json = {
          options: d.options.map((o) => ({ value: o.value.trim(), label: o.label.trim() })),
        };
      }
      if (d.validation_json) q.validation_json = d.validation_json;
      return q;
    }),
  };
}

/**
 * 校验题目草稿列表；返回第一条错误文案，合法返回 null。
 * 规则与后端 super.pb.js 模板端点逐条对齐（服务端为最终强制点，此处提前拦截）。
 */
export function validateQuestionDrafts(drafts: TemplateQuestionDraft[]): string | null {
  if (drafts.length === 0) return '至少需要 1 道题目';
  const seen = new Set<string>();
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const at = `第 ${i + 1} 题`;
    const code = d.question_code.trim();
    if (!code) return `${at}：question_code 必填`;
    if (!/^[A-Za-z0-9_]{1,50}$/.test(code)) {
      return `${at}：question_code 仅允许字母/数字/下划线（≤50 字符）`;
    }
    if (seen.has(code)) return `${at}：question_code 重复（${code}）`;
    seen.add(code);
    if (!TEMPLATE_QUESTION_TYPES.includes(d.question_type)) {
      return `${at}（${code}）：question_type 无效`;
    }
    if (!d.title.trim()) return `${at}（${code}）：title 必填`;
    if (CHOICE_QUESTION_TYPES.includes(d.question_type)) {
      if (d.options.length === 0) return `${at}（${code}）：选择题至少需 1 个选项`;
      const seenValue = new Set<string>();
      for (let j = 0; j < d.options.length; j++) {
        const o = d.options[j];
        if (!o.value.trim() || !o.label.trim()) {
          return `${at}（${code}）选项 ${j + 1}：value 与 label 必填`;
        }
        if (seenValue.has(o.value.trim())) {
          return `${at}（${code}）：选项 value 重复（${o.value.trim()}）`;
        }
        seenValue.add(o.value.trim());
      }
    }
  }
  return null;
}
