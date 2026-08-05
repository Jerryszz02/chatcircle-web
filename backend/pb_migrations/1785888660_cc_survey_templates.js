/// <reference path="../pb_data/types.d.ts" />

// 迁移 12：survey_templates + survey_template_versions — 标准模板索引与不可变模板版本
// 依据：database-design §5.2.12/§5.2.13；PRD FR-SUR-001/011、AC-13。
// - 两集合互相引用（templates.current_version_id ↔ versions.template_id），无法一次建成，
//   故 up 分三步：先建 templates（暂缺 current_version_id）→ 建 versions → 回补 templates 的
//   current_version_id 必填 relation；down 先移除该字段解除循环再按序删除。
// - survey_template_versions 不可变：发布后 update/delete 均禁止（规则关闭，服务端无入口）；
//   模板更新 = 新增版本行 + 移动 current_version_id，已有活动问卷固定原版本（FR-SUR-011、AC-13）。
// - schema_json 为题目完整定义快照（含 question_code、题型、选项、locked、is_sensitive、计分定义）；
//   标准模板题目内容 PRD 未写死（待确认 D-2），本表只提供结构能力。
// API Rules 要点：仅 _superusers 可写（FR-SUR-001）；机构管理员只读（含模板与全部版本）；
// 参与者不直接访问（问卷内容经 hooks 按资格下发）。

migrate((app) => {
  // 第一步：survey_templates（暂缺 current_version_id，打破循环引用）
  const templates = new Collection({
    type: 'base',
    name: 'survey_templates',
    listRule: "@request.auth.organization_id != ''",
    viewRule: "@request.auth.organization_id != ''",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      // 大写下划线，如 PARTICIPANT_PRE_V1（PRD 附录 B）
      { type: 'text', name: 'template_code', required: true },
      { type: 'text', name: 'name', required: true },
      { type: 'text', name: 'description', required: false },
      // active / disabled：停用代替删除
      { type: 'select', name: 'status', required: true, maxSelect: 1, values: ['active', 'disabled'] },
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: ['CREATE UNIQUE INDEX idx_survey_templates_code ON survey_templates (template_code)'],
  });
  app.save(templates);

  // 第二步：survey_template_versions（template_id -> survey_templates）
  const versions = new Collection({
    type: 'base',
    name: 'survey_template_versions',
    listRule: "@request.auth.organization_id != ''",
    viewRule: "@request.auth.organization_id != ''",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        type: 'relation',
        name: 'template_id',
        required: true,
        collectionId: templates.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      { type: 'number', name: 'version', required: true, onlyInt: true, min: 1 }, // 递增整数版本号
      { type: 'json', name: 'schema_json', required: true }, // 题目完整定义快照
      { type: 'date', name: 'published_at', required: true },
      { type: 'text', name: 'published_by', required: true }, // 发布的超级管理员 id
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: ['CREATE UNIQUE INDEX idx_survey_template_versions_tpl_version ON survey_template_versions (template_id, version)'],
  });
  app.save(versions);

  // 第三步：回补 survey_templates.current_version_id（必填 relation -> survey_template_versions）
  const templatesReload = app.findCollectionByNameOrId('survey_templates');
  templatesReload.fields.addAt(
    4, // 位置在 description 之后、status 之前（与设计文档字段顺序一致，仅为可读性）
    new RelationField({
      name: 'current_version_id',
      required: true, // 指向当前生效版本；复制活动问卷时取此版本（FR-SUR-011）
      collectionId: versions.id,
      cascadeDelete: false,
      maxSelect: 1,
    }),
  );
  return app.save(templatesReload);
}, (app) => {
  // 先移除 current_version_id 解除循环引用，再按序删除两集合
  const templates = app.findCollectionByNameOrId('survey_templates');
  templates.fields.removeByName('current_version_id');
  app.save(templates);

  const versions = app.findCollectionByNameOrId('survey_template_versions');
  app.delete(versions);

  return app.delete(templates);
});
