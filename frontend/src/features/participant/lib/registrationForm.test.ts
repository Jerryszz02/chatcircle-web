import { describe, expect, it } from 'vitest';
import type { PublicRegistrationField } from '../api';
import { parseChoiceOptions } from './choiceOptions';
import {
  buildRegistrationAnswersPayload,
  buildRegistrationFormModel,
  isFieldApplicable,
  validateFieldValue,
  validateRegistrationForm,
  type RegistrationFieldModel,
} from './registrationForm';

/**
 * 报名表渲染与校验逻辑单测（FR-REG-001/002；test-plan §2 表单组件）。
 * 覆盖：选项解析、标准+自定义字段渲染模型、按角色过滤、各题型校验、提交载荷组装。
 */

function field(partial: Partial<PublicRegistrationField>): PublicRegistrationField {
  return {
    id: 'fd_x',
    field_code: 'x',
    field_type: 'text',
    label: '字段',
    source_type: 'standard',
    is_sensitive: false,
    required: false,
    role_scope: 'both',
    ...partial,
  };
}

describe('parseChoiceOptions 选项解析（options_json 结构 PRD 未写死，兼容多形态）', () => {
  it('标准形态 [{value,label}]', () => {
    expect(
      parseChoiceOptions([
        { value: 'f', label: '女' },
        { value: 'm', label: '男' },
      ]),
    ).toEqual([
      { value: 'f', label: '女' },
      { value: 'm', label: '男' },
    ]);
  });

  it('字符串简写与对象包裹形态', () => {
    expect(parseChoiceOptions(['学业', '情感'])).toEqual([
      { value: '学业', label: '学业' },
      { value: '情感', label: '情感' },
    ]);
    expect(parseChoiceOptions({ options: [{ value: 'a', label: 'A' }] })).toEqual([
      { value: 'a', label: 'A' },
    ]);
  });

  it('空值与非法条目', () => {
    expect(parseChoiceOptions(null)).toEqual([]);
    expect(parseChoiceOptions(undefined)).toEqual([]);
    expect(parseChoiceOptions('weird')).toEqual([]);
    expect(parseChoiceOptions([{ label: '无value' }, '', { value: 'ok', label: '好' }])).toEqual([
      { value: 'ok', label: '好' },
    ]);
  });
});

describe('buildRegistrationFormModel 渲染模型（标准 + 机构自定义字段）', () => {
  it('映射字段标记并解析选项；非选择题不带选项', () => {
    const models = buildRegistrationFormModel([
      field({ id: 'fd1', field_code: 'real_name', label: '姓名', is_sensitive: true, required: true }),
      field({
        id: 'fd2',
        field_code: 'org_custom',
        label: '机构自定义',
        source_type: 'custom',
        field_type: 'single_choice',
        options_json: [{ value: 'a', label: 'A' }],
      }),
    ]);
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: 'fd1',
      fieldCode: 'real_name',
      isSensitive: true,
      required: true,
      sourceType: 'standard',
      roleScope: 'both',
      options: [],
    });
    expect(models[1]).toMatchObject({
      sourceType: 'custom',
      options: [{ value: 'a', label: 'A' }],
    });
  });

  it('保持服务端下发顺序（排序由服务端按活动配置决定）', () => {
    const models = buildRegistrationFormModel([
      field({ id: 'z' }),
      field({ id: 'a', source_type: 'custom' }),
    ]);
    expect(models.map((m) => m.id)).toEqual(['z', 'a']);
  });
});

describe('buildRegistrationFormModel 按角色过滤（role_scope）', () => {
  const fields = [
    field({ id: 'fd_both', label: '通用' }),
    field({ id: 'fd_speaker', label: '倾诉者专属', role_scope: 'speaker' }),
    field({ id: 'fd_listener', label: '聆听者专属', role_scope: 'listener' }),
  ];

  it('未选角色：只出 both 字段', () => {
    const models = buildRegistrationFormModel(fields, '');
    expect(models.map((m) => m.id)).toEqual(['fd_both']);
  });

  it('选定倾诉者：both + speaker 字段', () => {
    const models = buildRegistrationFormModel(fields, 'speaker');
    expect(models.map((m) => m.id)).toEqual(['fd_both', 'fd_speaker']);
  });

  it('选定聆听者：both + listener 字段', () => {
    const models = buildRegistrationFormModel(fields, 'listener');
    expect(models.map((m) => m.id)).toEqual(['fd_both', 'fd_listener']);
  });

  it('isFieldApplicable：both 恒适用，角色字段仅对应角色适用', () => {
    expect(isFieldApplicable('both', '')).toBe(true);
    expect(isFieldApplicable('both', 'speaker')).toBe(true);
    expect(isFieldApplicable('speaker', '')).toBe(false);
    expect(isFieldApplicable('speaker', 'speaker')).toBe(true);
    expect(isFieldApplicable('speaker', 'listener')).toBe(false);
    expect(isFieldApplicable('listener', 'listener')).toBe(true);
  });
});

function modelOf(partial: Partial<RegistrationFieldModel>): RegistrationFieldModel {
  return {
    id: 'fd1',
    fieldCode: 'x',
    fieldType: 'text',
    label: '字段',
    sourceType: 'standard',
    isSensitive: false,
    required: true,
    roleScope: 'both',
    options: [],
    ...partial,
  };
}

describe('validateFieldValue 各题型校验', () => {
  it('text：必填判空，非必填可空', () => {
    expect(validateFieldValue(modelOf({}), '  ')).toContain('请填写');
    expect(validateFieldValue(modelOf({ required: false }), '')).toBeNull();
    expect(validateFieldValue(modelOf({}), '内容')).toBeNull();
  });

  it('number：非数字拒绝', () => {
    const m = modelOf({ fieldType: 'number' });
    expect(validateFieldValue(m, 'abc')).toContain('数字');
    expect(validateFieldValue(m, '25')).toBeNull();
  });

  it('date：格式与真实日期校验', () => {
    const m = modelOf({ fieldType: 'date' });
    expect(validateFieldValue(m, '2026/01/01')).toContain('日期');
    expect(validateFieldValue(m, '2026-13-01')).toContain('日期');
    expect(validateFieldValue(m, '2026-02-30')).toContain('日期');
    expect(validateFieldValue(m, '2026-02-28')).toBeNull();
  });

  it('single_choice：必须命中选项', () => {
    const m = modelOf({
      fieldType: 'single_choice',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    expect(validateFieldValue(m, 'c')).toContain('选项无效');
    expect(validateFieldValue(m, 'a')).toBeNull();
  });

  it('multi_choice：必填至少一项，逐项命中', () => {
    const m = modelOf({
      fieldType: 'multi_choice',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    expect(validateFieldValue(m, [])).toContain('请填写');
    expect(validateFieldValue(m, ['a', 'c'])).toContain('选项无效');
    expect(validateFieldValue(m, ['a', 'b'])).toBeNull();
    expect(validateFieldValue(modelOf({ fieldType: 'multi_choice', required: false, options: [] }), [])).toBeNull();
  });
});

describe('validateRegistrationForm 整表校验（角色必选，FR-REG-002）', () => {
  const models = [modelOf({ id: 'fd1', label: '姓名' })];

  it('缺角色与必填字段时给出两组错误', () => {
    const res = validateRegistrationForm(models, {}, '');
    expect(res.ok).toBe(false);
    expect(res.roleError).toContain('请选择活动角色');
    expect(res.fieldErrors['fd1']).toContain('请填写');
  });

  it('全部满足时 ok', () => {
    const res = validateRegistrationForm(models, { fd1: '张三' }, 'speaker');
    expect(res.ok).toBe(true);
  });

  it('角色专属必填字段：仅对适用角色校验', () => {
    const scoped = [
      modelOf({ id: 'fd_both', label: '通用' }),
      modelOf({ id: 'fd_listener', label: '聆听者专属', roleScope: 'listener' }),
    ];
    const values = { fd_both: '已填写' };
    // 聆听者：专属必填缺失 → 报错
    const asListener = validateRegistrationForm(scoped, values, 'listener');
    expect(asListener.ok).toBe(false);
    expect(asListener.fieldErrors['fd_listener']).toContain('请填写');
    // 倾诉者：该字段不适用 → 不校验
    const asSpeaker = validateRegistrationForm(scoped, values, 'speaker');
    expect(asSpeaker.ok).toBe(true);
    expect(asSpeaker.fieldErrors['fd_listener']).toBeUndefined();
  });
});

describe('buildRegistrationAnswersPayload 提交载荷', () => {
  it('number 转数值、text 去空白、未作答非必填不下发、多选为数组', () => {
    const models = [
      modelOf({ id: 'fd_name', fieldType: 'text', label: '姓名' }),
      modelOf({ id: 'fd_age', fieldType: 'number', label: '年龄', required: false }),
      modelOf({
        id: 'fd_topics',
        fieldType: 'multi_choice',
        label: '话题',
        required: false,
        options: [{ value: 'a', label: 'A' }],
      }),
      modelOf({ id: 'fd_note', fieldType: 'text', label: '备注', required: false }),
    ];
    const payload = buildRegistrationAnswersPayload(models, {
      fd_name: '  张三  ',
      fd_age: '25',
      fd_topics: ['a'],
      fd_note: '   ',
    });
    expect(payload).toEqual([
      { field_def_id: 'fd_name', value: '张三' },
      { field_def_id: 'fd_age', value: 25 },
      { field_def_id: 'fd_topics', value: ['a'] },
    ]);
  });

  it('传入角色时不适用字段的已填值不下发（切换角色残留值不提交）', () => {
    const models = [
      modelOf({ id: 'fd_both', fieldType: 'text', label: '通用' }),
      modelOf({ id: 'fd_listener', fieldType: 'text', label: '聆听者专属', roleScope: 'listener' }),
    ];
    const values = { fd_both: '通用答案', fd_listener: '残留答案' };
    // 不传 role：全量输出（兼容旧调用形态）
    expect(buildRegistrationAnswersPayload(models, values)).toHaveLength(2);
    // 传 role=speaker：listener 专属字段不下发
    expect(buildRegistrationAnswersPayload(models, values, 'speaker')).toEqual([
      { field_def_id: 'fd_both', value: '通用答案' },
    ]);
    // 传 role=listener：两者都下发
    expect(buildRegistrationAnswersPayload(models, values, 'listener')).toHaveLength(2);
  });
});
