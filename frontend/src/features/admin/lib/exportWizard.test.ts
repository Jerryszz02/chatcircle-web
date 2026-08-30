import { describe, expect, it } from 'vitest';

import {
  applyExportPreset,
  buildExportSelection,
  clientSensitiveHints,
  EXPORT_PRESETS,
  initialExportWizardState,
  parseParticipantIds,
  validateExportWizardStep,
  type ExportFieldMeta,
  type ExportQuestionMeta,
} from './exportWizard';

const FIELDS: ExportFieldMeta[] = [
  { field_code: 'FULL_NAME', is_sensitive: true },
  { field_code: 'GENDER', is_sensitive: false },
  { field_code: 'AGE_RANGE', is_sensitive: false },
  { field_code: 'WX_CONTACT', is_sensitive: true },
];

const QUESTIONS: ExportQuestionMeta[] = [
  { activity_survey_id: 'sv1', question_code: 'MOOD', is_sensitive: true },
  { activity_survey_id: 'sv1', question_code: 'SAT', is_sensitive: false },
  { activity_survey_id: 'sv2', question_code: 'NOTE', is_sensitive: false },
];

function preset(code: string) {
  const p = EXPORT_PRESETS.find((x) => x.code === code);
  if (!p) throw new Error(`预设不存在：${code}`);
  return p;
}

describe('parseParticipantIds', () => {
  it('解析多种分隔符并去重保序', () => {
    const { ids, invalid } = parseParticipantIds('abc123, def_456\nghi；abc123，， ');
    expect(ids).toEqual(['abc123', 'def_456', 'ghi']);
    expect(invalid).toEqual([]);
  });

  it('非法字符进入 invalid', () => {
    const { ids, invalid } = parseParticipantIds('ok_id, bad-id!');
    expect(ids).toEqual(['ok_id']);
    expect(invalid).toEqual(['bad-id!']);
  });

  it('空输入返回空', () => {
    expect(parseParticipantIds('  ')).toEqual({ ids: [], invalid: [] });
  });
});

describe('buildExportSelection', () => {
  it('组装冻结契约形状（schema_version=2，默认时区/格式）', () => {
    const state = initialExportWizardState();
    state.scopeType = 'activity';
    state.activityId = 'act1';
    const sel = buildExportSelection(state);
    expect(sel.schema_version).toBe(2);
    expect(sel.scope).toEqual({ type: 'activity', activity_id: 'act1' });
    expect(sel.format).toBe('xlsx');
    expect(sel.timezone).toBe('Asia/Shanghai');
    expect(sel.filters.checkin).toBe('any');
    expect(sel.filters.participant_ids).toEqual([]);
  });

  it('机构范围 + 日期区间 + 指定参与者行筛选', () => {
    const state = initialExportWizardState();
    state.dateFrom = '2026-08-01';
    state.dateTo = '2026-08-31';
    state.participantIdsText = 'p1, p2';
    const sel = buildExportSelection(state);
    expect(sel.scope).toEqual({
      type: 'organization',
      date_range: { from: '2026-08-01', to: '2026-08-31' },
    });
    expect(sel.filters.participant_ids).toEqual(['p1', 'p2']);
  });
});

describe('validateExportWizardStep', () => {
  it('第 1 步：单活动必须选活动，日期校验', () => {
    const state = initialExportWizardState();
    state.scopeType = 'activity';
    expect(validateExportWizardStep(state, 1)).toContain('请选择要导出的活动');
    state.activityId = 'a1';
    state.dateFrom = '2026-08-31';
    state.dateTo = '2026-08-01';
    expect(validateExportWizardStep(state, 1)).toContain('开始日期不能晚于结束日期');
    state.dateTo = '';
    expect(validateExportWizardStep(state, 1)).toEqual([]);
  });

  it('第 2 步：至少一个数据域', () => {
    const state = initialExportWizardState();
    state.datasets = [];
    expect(validateExportWizardStep(state, 2)).toContain('请至少选择一个数据域');
  });

  it('第 3 步：非法参与者 ID 报错', () => {
    const state = initialExportWizardState();
    state.participantIdsText = 'bad-id';
    expect(validateExportWizardStep(state, 3).join()).toContain('非法字符');
  });

  it('第 4 步：报名/问卷域要求至少一列；未选问卷域不能选题', () => {
    const state = initialExportWizardState();
    state.systemColumns = [];
    expect(validateExportWizardStep(state, 4)).toContain('请至少选择一个系统列、报名字段或问卷题目');
    state.systemColumns = ['participant_id'];
    state.questionSelections = [{ activity_survey_id: 'sv1', question_codes: ['SAT'] }];
    expect(validateExportWizardStep(state, 4)).toContain('未选问卷数据域时不能选择问卷题目');
    state.datasets = ['surveys'];
    expect(validateExportWizardStep(state, 4)).toEqual([]);
  });
});

describe('applyExportPreset', () => {
  it('联系名单含 FULL_NAME（敏感）+ 掩码手机号', () => {
    const patch = applyExportPreset(preset('contact_list'), { fields: FIELDS, questions: QUESTIONS });
    expect(patch.fieldCodes).toEqual(['FULL_NAME']);
    expect(patch.systemColumns).toContain('phone_masked');
    expect(patch.systemColumns).not.toContain('phone_full');
  });

  it('参与者结构数据只展开非敏感字段', () => {
    const patch = applyExportPreset(preset('participant_structure'), { fields: FIELDS, questions: QUESTIONS });
    expect(patch.fieldCodes).toEqual(['GENDER', 'AGE_RANGE']);
    expect(patch.fieldCodes).not.toContain('FULL_NAME');
  });

  it('单份问卷结果只展开非敏感题目且按问卷分组', () => {
    const patch = applyExportPreset(preset('single_survey'), { fields: FIELDS, questions: QUESTIONS });
    expect(patch.questionSelections).toEqual([
      { activity_survey_id: 'sv1', question_codes: ['SAT'] },
      { activity_survey_id: 'sv2', question_codes: ['NOTE'] },
    ]);
  });

  it('现场配对表预设已签到筛选', () => {
    const patch = applyExportPreset(preset('onsite_pairs'), { fields: FIELDS, questions: QUESTIONS });
    expect(patch.checkin).toBe('valid');
    expect(patch.systemColumns).toContain('partner_name');
  });
});

describe('clientSensitiveHints', () => {
  it('提示命中敏感系统列/字段/题目（仅 UI 提示）', () => {
    const state = initialExportWizardState();
    state.systemColumns = ['participant_id', 'phone_full'];
    state.fieldCodes = ['FULL_NAME', 'GENDER'];
    state.questionSelections = [{ activity_survey_id: 'sv1', question_codes: ['MOOD', 'SAT'] }];
    const hints = clientSensitiveHints(state, { fields: FIELDS, questions: QUESTIONS });
    expect(hints.sort()).toEqual(['FULL_NAME', 'MOOD', 'phone_full']);
  });

  it('掩码手机号不命中', () => {
    const state = initialExportWizardState();
    state.systemColumns = ['phone_masked'];
    expect(clientSensitiveHints(state, { fields: FIELDS, questions: QUESTIONS })).toEqual([]);
  });
});
