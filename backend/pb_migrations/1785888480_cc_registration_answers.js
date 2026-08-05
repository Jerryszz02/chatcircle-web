/// <reference path="../pb_data/types.d.ts" />

// 迁移 09：registration_answers — 报名字段答案
// 依据：database-design §5.2.9；PRD §9.2、§10.3。
// - value_json 存答案值；多选用标准 JSON 数组（PRD §10.3）。
// - is_sensitive 由 field_def_id 反查 registration_field_defs（导出过滤，FR-EXP-002）。
// - 日志不得记录完整敏感答案（PRD §11.2）。
// API Rules 要点：
// - 参与者随报名创建写入（仅本人报名的答案），之后只读（update/delete 关闭）；
// - 管理员按机构隔离只读（经 registration_id.activity_id.organization_id 两级反查，PRD §9.2）。

migrate((app) => {
  const registrations = app.findCollectionByNameOrId('registrations');
  const fieldDefs = app.findCollectionByNameOrId('registration_field_defs');

  const collection = new Collection({
    type: 'base',
    name: 'registration_answers',
    listRule:
      '@request.auth.organization_id = registration_id.activity_id.organization_id || @request.auth.id = registration_id.participant_id',
    viewRule:
      '@request.auth.organization_id = registration_id.activity_id.organization_id || @request.auth.id = registration_id.participant_id',
    createRule: '@request.auth.id = registration_id.participant_id',
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        type: 'relation',
        name: 'registration_id',
        required: true,
        collectionId: registrations.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      // 答案对应的字段定义（is_sensitive 由此反查）
      {
        type: 'relation',
        name: 'field_def_id',
        required: true,
        collectionId: fieldDefs.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      { type: 'json', name: 'value_json', required: true },
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      // 同一报名同一字段仅一条答案
      'CREATE UNIQUE INDEX idx_registration_answers_reg_field ON registration_answers (registration_id, field_def_id)',
      'CREATE INDEX idx_registration_answers_field_def ON registration_answers (field_def_id)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('registration_answers');
  return app.delete(collection);
});
