/// <reference path="../pb_data/types.d.ts" />

// 迁移 04：participant_accounts — 全平台通用参与者账号（auth 集合）
// 依据：database-design §5.2.4；PRD FR-AUTH-001~008。
// - 不绑定任何机构（FR-AUTH-003）；不存手机号、邮箱、微信等任何联系方式（FR-AUTH-002）。
// - username 全局唯一且字母不区分大小写（FR-AUTH-005）：存储统一归一化为小写（由 hooks 完成），
//   字段 pattern 仅允许小写字符，唯一索引兜底（PocketBase 唯一约束区分大小写，故必须归一化）。
// - 会话 30 天：authToken.duration = 2592000 秒（FR-AUTH-006）。
// - email/emailVisibility/verified 为 PocketBase auth 集合强制系统字段（0.28 自动追加、不可移除）；
//   业务上不使用，email 声明为 required=false 且恒为空串。
// API Rules 要点：
// - 参与者仅能 view/update 本人记录（@request.auth.id = id），且不可改 username（PRD §3.2，
//   机构管理员也不得修改参与者凭据，:isset 守卫）；
// - list 关闭（无参与者名录）；create 仅经报名链路自动注册 hook（服务端，technical-design §5.4）；
// - deleteRule 关闭（无硬删除）；无密码重置/找回入口（任何角色，PRD §5.7）；
// - authRule 拒绝已停用账号登录（账号停用为可审计事件，PRD §11.3）。

migrate((app) => {
  const collection = new Collection({
    type: 'auth',
    name: 'participant_accounts',
    listRule: null,
    viewRule: '@request.auth.id = id',
    createRule: null,
    updateRule: '@request.auth.id = id && (@request.body.username:isset = false || @request.body.username = username)',
    deleteRule: null,
    authRule: "status = 'active'",
    passwordAuth: { enabled: true, identityFields: ['username'] },
    authAlert: { enabled: false }, // 无邮箱业务，关闭新设备登录邮件提醒
    authToken: { duration: 2592000 }, // 30 天（FR-AUTH-006）
    fields: [
      // 4–20 位小写字母/数字/下划线；小写归一化由 hooks 保证（FR-AUTH-005）
      { type: 'text', name: 'username', required: true, pattern: '^[a-z0-9_]{4,20}$' },
      // active=正常 / disabled=停用
      { type: 'select', name: 'status', required: true, maxSelect: 1, values: ['active', 'disabled'] },
      // 以下为 PocketBase auth 集合强制系统字段，业务不使用（见文件头注释）
      { type: 'email', name: 'email', required: false },
      { type: 'bool', name: 'emailVisibility', required: false },
      { type: 'bool', name: 'verified', required: false },
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_participant_accounts_username ON participant_accounts (username)',
      // created 即 PRD §9.1 的 created_at，跨活动账号连续性统计可用（database-design §5.2.4）
      'CREATE INDEX idx_participant_accounts_created ON participant_accounts (created)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('participant_accounts');
  return app.delete(collection);
});
