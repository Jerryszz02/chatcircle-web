/// <reference path="../pb_data/types.d.ts" />

// 迁移 07：registration_field_defs — 报名字段定义（标准字段库 + 机构自定义字段）
// 依据：database-design §5.2.7；PRD §8.1、FR-REG-001、FR-EXP-002。
// - organization_id 为空（PocketBase 空 relation 存 ''，非 NULL）= 平台标准字段，仅 _superusers 维护；
//   非空 = 机构自定义字段。空串可被唯一索引正常比较，故复合唯一索引 (organization_id, field_code)
//   对标准字段（同为 ''）与机构自定义字段（按机构隔离）同时生效。
// - is_sensitive 为普通导出排除/掩码的唯一依据（不依赖字段名判断，FR-EXP-002）。
// - field_type 题型集为草案（待确认 D-1）：标准字段具体内容 PRD 未写死，本表只提供能力层。
// API Rules 要点：
// - list/view：机构管理员可读「本机构自定义 + 平台标准」两类；参与者报名表单经 hooks 服务端组装下发；
//   规则首段 @request.auth.organization_id != '' 防止参与者/未认证命中 ''='' 读到标准字段；
// - create：机构管理员只能为本机构建 source_type=custom 的字段（不能改标准字段代码与类型，PRD §8.1）；
// - update：仅本机构自定义字段；deleteRule 关闭（停用代替删除）。

migrate((app) => {
  const organizations = app.findCollectionByNameOrId('organizations');

  const collection = new Collection({
    type: 'base',
    name: 'registration_field_defs',
    listRule: "@request.auth.organization_id != '' && (@request.auth.organization_id = organization_id || organization_id = '')",
    viewRule: "@request.auth.organization_id != '' && (@request.auth.organization_id = organization_id || organization_id = '')",
    createRule:
      "organization_id != '' && @request.auth.organization_id = organization_id && source_type = 'custom'",
    updateRule: "@request.auth.organization_id != '' && @request.auth.organization_id = organization_id",
    deleteRule: null,
    fields: [
      // 空 = 平台标准字段（超级管理员维护）；非空 = 机构自定义字段（PRD §8.1）
      {
        type: 'relation',
        name: 'organization_id',
        required: false,
        collectionId: organizations.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      // 稳定机器代码；标准字段代码不可改（FR-REG-001）
      { type: 'text', name: 'field_code', required: true },
      // 草案题型集（待确认 D-1），随标准字段定义确认后定稿；枚举只增不改
      {
        type: 'select',
        name: 'field_type',
        required: true,
        maxSelect: 1,
        values: ['text', 'number', 'single_choice', 'multi_choice', 'date'],
      },
      { type: 'text', name: 'label', required: true }, // 展示文案
      // standard=平台标准 / custom=机构自定义；导出 custom_fields.csv 单独标记自定义内容（PRD §2.3、§10.1）
      { type: 'select', name: 'source_type', required: true, maxSelect: 1, values: ['standard', 'custom'] },
      // 敏感标记：普通导出按此排除/掩码（FR-EXP-002）
      { type: 'bool', name: 'is_sensitive', required: false },
      { type: 'json', name: 'options_json', required: false }, // 选项机器值与显示文本
      // 默认必填建议；活动级覆盖见 activities.form_config_json
      { type: 'bool', name: 'required_default', required: false },
      // active / disabled：停用代替删除
      { type: 'select', name: 'status', required: true, maxSelect: 1, values: ['active', 'disabled'] },
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_registration_field_defs_org_code ON registration_field_defs (organization_id, field_code)',
      'CREATE INDEX idx_registration_field_defs_org ON registration_field_defs (organization_id)',
      'CREATE INDEX idx_registration_field_defs_source_type ON registration_field_defs (source_type)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('registration_field_defs');
  return app.delete(collection);
});
