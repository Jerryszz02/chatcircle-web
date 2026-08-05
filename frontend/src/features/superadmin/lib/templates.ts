/**
 * 标准问卷模板展示辅助（FR-SUR-001/011/012）。
 *
 * survey_template_versions.schema_json 为题目完整定义快照（database-design §5.2.13），
 * 模板具体题目内容 PRD 未写死（technical-design 待确认 #5），此处按能力层实现：
 * 防御式解析 schema_json.questions 数组用于版本题目预览与锁定题标识展示，
 * 解析不到结构时页面降级为只显示版本元信息。
 */

/** 版本题目预览视图（从 schema_json 提取）。 */
export interface TemplateQuestionView {
  question_code: string;
  title: string;
  question_type: string;
  /** 核心锁定题标识：机构不能修改或删除（FR-SUR-001）。 */
  locked: boolean;
  /** 敏感题标识：普通导出按此过滤（FR-SUR-012）。 */
  is_sensitive: boolean;
  required: boolean;
}

/** 从 schema_json 提取题目列表；结构不符时返回空数组（页面降级展示）。 */
export function extractTemplateQuestions(schema: unknown): TemplateQuestionView[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const questions = (schema as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  return questions
    .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
    .map((q) => ({
      question_code: typeof q.question_code === 'string' ? q.question_code : '',
      title: typeof q.title === 'string' ? q.title : '',
      question_type: typeof q.question_type === 'string' ? q.question_type : '',
      locked: q.locked === true,
      is_sensitive: q.is_sensitive === true,
      required: q.required === true,
    }));
}

/** 统计锁定题数量（版本列表「锁定题数」列）。 */
export function countLockedQuestions(schema: unknown): number {
  return extractTemplateQuestions(schema).filter((q) => q.locked).length;
}

/** 解析并校验发布新版本时输入的 schema JSON 文本。返回错误文案，合法返回 null。 */
export function validateSchemaJsonText(text: string): string | null {
  if (text.trim() === '') return '请填写题目定义 JSON';
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return '题目定义必须是 JSON 对象（建议包含 questions 数组）';
    }
    return null;
  } catch {
    return 'JSON 格式不合法，请检查后再提交';
  }
}
