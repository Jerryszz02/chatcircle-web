/**
 * 选项解析（报名字段 options_json 与问卷题目 options_json 共用）。
 *
 * PRD 未写死 options_json 内部结构（database-design D-1/D-2 待确认），
 * 按机器值 + 显示文本解析，并兼容以下形态：
 * - [{ value, label }, ...]（约定主形态）
 * - ['A', 'B']（字符串简写，value = label）
 * - { options: [...] }（对象包裹）
 * 非法条目一律跳过；解析不出任何选项时返回空数组，由渲染层兜底提示。
 */

export interface ChoiceOption {
  value: string;
  label: string;
}

function toOption(item: unknown): ChoiceOption | null {
  if (typeof item === 'string' && item !== '') return { value: item, label: item };
  if (typeof item === 'object' && item !== null) {
    const raw = item as Record<string, unknown>;
    const value = raw['value'];
    const label = raw['label'];
    if (typeof value === 'string' && value !== '') {
      return { value, label: typeof label === 'string' && label !== '' ? label : value };
    }
  }
  return null;
}

export function parseChoiceOptions(optionsJson: unknown): ChoiceOption[] {
  let list: unknown = optionsJson;
  if (typeof list === 'object' && list !== null && !Array.isArray(list)) {
    list = (list as Record<string, unknown>)['options'];
  }
  if (!Array.isArray(list)) return [];
  return list.map(toOption).filter((o): o is ChoiceOption => o !== null);
}
