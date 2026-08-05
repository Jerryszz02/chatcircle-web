/// <reference path="../pb_data/types.d.ts" />

// 迁移 03：admin_invites — 一次性管理员邀请码
// 依据：database-design §5.2.2；PRD §4.2、§9.1、FR-ORG-002/003。
// - 只存 token_hash（邀请码明文的哈希），明文生成后仅展示一次、不落库（security-privacy §7，PRD §11.2 精神）。
// - 状态机 4 态：unused=未使用 / used=已使用 / revoked=已撤销 / expired=已过期（默认生成后 7 天，可调整）。
// API Rules 要点：全部锁定（仅 _superusers 可 list/create/update）；
// 注册走 hooks 自定义端点，事务内校验 status=unused 且未过期，注册成功同事务置 used（AC-02，database-design §5.6）。

migrate((app) => {
  const organizations = app.findCollectionByNameOrId('organizations');
  const adminAccounts = app.findCollectionByNameOrId('admin_accounts');

  const collection = new Collection({
    type: 'base',
    name: 'admin_invites',
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        type: 'relation',
        name: 'organization_id',
        required: true,
        collectionId: organizations.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      { type: 'text', name: 'token_hash', required: true }, // 邀请码哈希，唯一
      {
        type: 'select',
        name: 'status',
        required: true,
        maxSelect: 1,
        values: ['unused', 'used', 'revoked', 'expired'],
      },
      { type: 'date', name: 'expires_at', required: true }, // 默认生成后 7 天（PRD §4.2）
      // 成功注册的管理员（未使用为空）
      {
        type: 'relation',
        name: 'used_by',
        required: false,
        collectionId: adminAccounts.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      { type: 'date', name: 'used_at', required: false },
      { type: 'text', name: 'created_by', required: true }, // 操作者（超级管理员 id）
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_admin_invites_token_hash ON admin_invites (token_hash)',
      'CREATE INDEX idx_admin_invites_organization ON admin_invites (organization_id)',
      'CREATE INDEX idx_admin_invites_status ON admin_invites (status)',
      'CREATE INDEX idx_admin_invites_expires_at ON admin_invites (expires_at)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('admin_invites');
  return app.delete(collection);
});
