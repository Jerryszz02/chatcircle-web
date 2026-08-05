/// <reference path="../pb_data/types.d.ts" />

// 迁移 02：admin_accounts — 机构管理员账号（auth 集合）
// 依据：database-design §5.2.3；PRD FR-AUTH-003/004。
// - 认证方式：username + 密码（passwordAuth.identityFields=['username']），密码哈希由 PocketBase 处理（FR-AUTH-004）。
// - 管理员用户名规则 PRD 未明确（technical-design 待确认 #3），暂套用参与者同一套：4–20 位字母/数字/下划线。
// - email/emailVisibility/verified 为 PocketBase auth 集合强制系统字段（0.28 自动追加、不可移除）；
//   业务上不使用邮箱，email 声明为 required=false 且恒为空串。
// API Rules 要点：
// - 管理员只能 list/view 本机构同事记录与本人记录（@request.auth.organization_id 匹配）；
// - create 仅经邀请码注册 hook（服务端事务，technical-design §5.4），故规则锁定；
// - update 仅本人，且禁止修改 organization_id（:isset 守卫，database-design §5.2.3）；
// - deleteRule 关闭（无硬删除，FR-AUD-001）；
// - authRule 拒绝已停用账号登录；机构停用后的操作拦截由 hooks 负责（FR-ORG-001，technical-design §5.4）。

migrate((app) => {
  const organizations = app.findCollectionByNameOrId('organizations');

  const collection = new Collection({
    type: 'auth',
    name: 'admin_accounts',
    listRule: '@request.auth.organization_id = organization_id',
    viewRule: '@request.auth.organization_id = organization_id',
    createRule: null,
    updateRule:
      '@request.auth.id = id && (@request.body.organization_id:isset = false || @request.body.organization_id = organization_id)',
    deleteRule: null,
    authRule: "status = 'active'",
    passwordAuth: { enabled: true, identityFields: ['username'] },
    // 无邮箱业务，关闭新设备登录邮件提醒
    authAlert: { enabled: false },
    // token 有效期暂取 PocketBase 默认 7 天；PRD 未给数值（technical-design 待确认 #2），确认后固化
    authToken: { duration: 604800 },
    fields: [
      { type: 'text', name: 'username', required: true, pattern: '^[A-Za-z0-9_]{4,20}$' },
      // 所属机构：管理员与参与者集合的关键差异（FR-AUTH-003）
      {
        type: 'relation',
        name: 'organization_id',
        required: true,
        collectionId: organizations.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      // active=正常 / disabled=停用；机构停用或账号停用时禁止进入后台
      { type: 'select', name: 'status', required: true, maxSelect: 1, values: ['active', 'disabled'] },
      { type: 'text', name: 'display_name', required: false }, // 后台显示名
      // 以下为 PocketBase auth 集合强制系统字段，业务不使用（见文件头注释）
      { type: 'email', name: 'email', required: false },
      { type: 'bool', name: 'emailVisibility', required: false },
      { type: 'bool', name: 'verified', required: false },
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: ['CREATE UNIQUE INDEX idx_admin_accounts_username ON admin_accounts (username)'],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('admin_accounts');
  return app.delete(collection);
});
