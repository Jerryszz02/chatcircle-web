/// <reference path="../pb_data/types.d.ts" />

// 迁移 14：survey_questions — 活动问卷题目
// 依据：database-design §5.2.15；PRD §8.3、FR-SUR-001/002/007/012。
// - question_code 为稳定机器字段：标准题跨模板/跨活动保持一致；自定义题活动内唯一（前缀如 CUS_ORG7_001）。
// - 复制模板 = 将 schema_json 中题目物化为本表行，复制后随活动问卷固化，模板升级不影响（AC-13）。
// - locked=true 为核心锁定题：机构不能修改或删除（FR-SUR-001，由 hooks 强制）；
//   机构可新增/排序/设必填自定义题（FR-SUR-002）。
// - is_sensitive 为普通导出过滤依据，进入 data_dictionary（FR-SUR-012、FR-EXP-002）。
// API Rules 要点：机构管理员按机构隔离读写（经 activity_survey_id.activity_id.organization_id 反查）；
// 参与者不直接访问（题目经 hooks 按问卷资格下发）；deleteRule 关闭（无硬删除）。

migrate((app) => {
  const activitySurveys = app.findCollectionByNameOrId('activity_surveys');

  const collection = new Collection({
    type: 'base',
    name: 'survey_questions',
    listRule: '@request.auth.organization_id = activity_survey_id.activity_id.organization_id',
    viewRule: '@request.auth.organization_id = activity_survey_id.activity_id.organization_id',
    createRule: '@request.auth.organization_id = activity_survey_id.activity_id.organization_id',
    updateRule: '@request.auth.organization_id = activity_survey_id.activity_id.organization_id',
    deleteRule: null,
    fields: [
      {
        type: 'relation',
        name: 'activity_survey_id',
        required: true,
        collectionId: activitySurveys.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      { type: 'text', name: 'question_code', required: true },
      // standard=模板核心题 / custom=机构新增题
      { type: 'select', name: 'source_type', required: true, maxSelect: 1, values: ['standard', 'custom'] },
      // info=说明 / single_choice=单选 / multi_choice=多选 / scale_1_5=1-5 / scale_0_10=0-10 /
      // text_short=单行 / text_long=多行（FR-SUR-007）
      {
        type: 'select',
        name: 'question_type',
        required: true,
        maxSelect: 1,
        values: ['info', 'single_choice', 'multi_choice', 'scale_1_5', 'scale_0_10', 'text_short', 'text_long'],
      },
      { type: 'text', name: 'title', required: true }, // 题干
      { type: 'bool', name: 'required', required: false }, // 机构可对非锁定题调整（FR-SUR-002）
      { type: 'json', name: 'options_json', required: false }, // 选项机器值与显示文本
      { type: 'bool', name: 'locked', required: false }, // 核心锁定题（FR-SUR-001）
      { type: 'bool', name: 'is_sensitive', required: false }, // 敏感标记；普通导出过滤依据（FR-SUR-012）
      { type: 'number', name: 'order_index', required: true, onlyInt: true, min: 0 }, // 显示顺序
      { type: 'json', name: 'validation_json', required: false }, // 范围、长度等校验（如 {"min":1,"max":5}）
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      // 同一问卷内 question_code 唯一
      'CREATE UNIQUE INDEX idx_survey_questions_survey_code ON survey_questions (activity_survey_id, question_code)',
      'CREATE INDEX idx_survey_questions_question_code ON survey_questions (question_code)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('survey_questions');
  return app.delete(collection);
});
