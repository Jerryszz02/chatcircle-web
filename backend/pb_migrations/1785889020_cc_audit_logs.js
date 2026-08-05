/// <reference path="../pb_data/types.d.ts" />

// 迁移 18：audit_logs — 不可变审计记录
// 依据：database-design §5.2.19；PRD §11.3、FR-AUD-001~005。
// - 不可变：仅开放服务端 create 与按权限 view；update/delete 规则全部关闭，
//   普通管理员不可修改（FR-AUD-002、FR-AUD-005）。
// - actor_id 为操作者 id；系统任务（备份）用 'system'。
// - action 为动作代码（如 registration.status_revert、export.sensitive、backup.failed）；
//   枚举清单由 security-privacy.md 细化，范围至少覆盖 FR-AUD-004（待确认 D-6）。
// - metadata 不得含密码或完整敏感答案（PRD §11.2）。
// - 保留 ≥1 年（FR-AUD-003），到期策略后续治理决定。
// API Rules 要点：机构管理员只读检索本机构（首段 != '' 防止参与者/未认证命中 ''='' 读到平台级事件）；
// 超级管理员经 _superusers 全量（天然绕过规则）；参与者不可见；create 仅服务端 hooks 统一 writeAudit()。

migrate((app) => {
  const organizations = app.findCollectionByNameOrId('organizations');

  const collection = new Collection({
    type: 'base',
    name: 'audit_logs',
    listRule: "@request.auth.organization_id != '' && @request.auth.organization_id = organization_id",
    viewRule: "@request.auth.organization_id != '' && @request.auth.organization_id = organization_id",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: 'text', name: 'actor_id', required: true }, // 操作者 id；系统任务用 'system'
      { type: 'select', name: 'actor_role', required: true, maxSelect: 1, values: ['super_admin', 'admin', 'participant', 'system'] },
      // 涉事机构；平台级事件为空
      {
        type: 'relation',
        name: 'organization_id',
        required: false,
        collectionId: organizations.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      { type: 'text', name: 'action', required: true }, // 动作代码（如 registration.status_revert）
      { type: 'text', name: 'target_type', required: true }, // 被操作对象类型
      { type: 'text', name: 'target_id', required: true }, // 被操作对象 id
      { type: 'select', name: 'result', required: true, maxSelect: 1, values: ['success', 'failure'] },
      { type: 'text', name: 'reason', required: false }, // 高风险操作原因（补签/回退/作废等必填）
      { type: 'json', name: 'metadata', required: false }, // 前后状态、上下文；不得含密码或完整敏感答案
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      // created 即审计口径的精确操作时间 created_at（FR-AUD-002）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE INDEX idx_audit_logs_actor_created ON audit_logs (actor_id, created)',
      'CREATE INDEX idx_audit_logs_org_created ON audit_logs (organization_id, created)',
      'CREATE INDEX idx_audit_logs_action ON audit_logs (action)',
      'CREATE INDEX idx_audit_logs_target ON audit_logs (target_type, target_id)',
      'CREATE INDEX idx_audit_logs_created ON audit_logs (created)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('audit_logs');
  return app.delete(collection);
});
