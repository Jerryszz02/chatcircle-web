/// <reference path="../pb_data/types.d.ts" />

// 迁移 01：organizations — 机构主数据与机构级开关
// 依据：database-design §5.2.1；PRD §9.1、FR-ORG-001/004/005。
// API Rules 要点：
// - 管理员只读本机构记录（@request.auth.organization_id = id；参与者/未认证无该字段，恒为 false）；
// - 写操作仅 _superusers（V1 机构创建/配置无管理员侧入口）；
// - deleteRule 关闭：无硬删除（FR-AUD-001），停用用 status 表达。

migrate((app) => {
  const collection = new Collection({
    type: 'base',
    name: 'organizations',
    listRule: '@request.auth.organization_id = id',
    viewRule: '@request.auth.organization_id = id',
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: 'text', name: 'name', required: true },
      // 机构状态：active=正常 / disabled=停用；停用后其管理员不能进入业务后台，历史数据保留（FR-ORG-001）
      { type: 'select', name: 'status', required: true, maxSelect: 1, values: ['active', 'disabled'] },
      // bool 约定：PocketBase 0.28 中 required=true 的 bool 会强制取值 true（false 被判为空值），
      // 设计文档标注「必填」的 bool 字段一律 required=false（零值 false 本身即有效值，「必填」语义由值必然存在满足）。
      { type: 'bool', name: 'require_activity_approval', required: false }, // 活动发布需平台审核开关（FR-ORG-004）
      { type: 'bool', name: 'allow_sensitive_export', required: false }, // 允许机构管理员敏感导出开关（FR-ORG-005）
      { type: 'text', name: 'remark', required: false }, // 内部备注
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: ['CREATE INDEX idx_organizations_status ON organizations (status)'],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('organizations');
  return app.delete(collection);
});
