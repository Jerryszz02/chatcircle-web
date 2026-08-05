/// <reference path="../pb_data/types.d.ts" />

// 迁移 11：checkins — 签到记录
// 依据：database-design §5.2.11；PRD §4.5、FR-CHK-003~006。
// - 「每活动每人仅一条有效签到」无法用 SQLite 部分唯一索引表达（撤销行需保留）：
//   由服务端 hooks 事务校验 + (activity_id, participant_id, status) 复合索引支撑查询
//   （FR-CHK-004、AC-09、AC-20）；不得建 (activity_id, participant_id) 全量唯一索引，
//   否则撤销后无法补签（database-design §5.2.11 原文要求）。
// - 「未签到」不建行；「已撤销」保留原记录（status=revoked，PRD §4.5）。
// - 实际参与人数/服务人次口径 = status=valid 记录数（FR-CHK-006、§7.1），看板与导出共用。
// API Rules 要点：
// - 管理员按机构隔离只读；参与者只读本人记录；
// - create/update 全部锁定：自助签到（幂等查重）、补签/撤销（原因必填 + 审计）均走
//   hooks 自定义端点（technical-design §5.5 checkins.pb.js）；deleteRule 关闭。

migrate((app) => {
  const activities = app.findCollectionByNameOrId('activities');
  const participantAccounts = app.findCollectionByNameOrId('participant_accounts');
  const registrations = app.findCollectionByNameOrId('registrations');

  const collection = new Collection({
    type: 'base',
    name: 'checkins',
    listRule: '@request.auth.organization_id = activity_id.organization_id || @request.auth.id = participant_id',
    viewRule: '@request.auth.organization_id = activity_id.organization_id || @request.auth.id = participant_id',
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        type: 'relation',
        name: 'activity_id',
        required: true,
        collectionId: activities.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      {
        type: 'relation',
        name: 'participant_id',
        required: true,
        collectionId: participantAccounts.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      // 关联报名（签到前置：报名状态=approved，FR-CHK-003，由 hooks 校验）
      {
        type: 'relation',
        name: 'registration_id',
        required: true,
        collectionId: registrations.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      // self_scan=自助扫码 / manual=管理员补签
      { type: 'select', name: 'source', required: true, maxSelect: 1, values: ['self_scan', 'manual'] },
      // valid=已签到 / revoked=已撤销
      { type: 'select', name: 'status', required: true, maxSelect: 1, values: ['valid', 'revoked'] },
      { type: 'date', name: 'checked_in_at', required: true },
      { type: 'text', name: 'operator_id', required: false }, // 补签/撤销操作管理员 id；自助签到为空
      { type: 'text', name: 'reason', required: false }, // 补签/撤销必填原因（FR-CHK-005），由 hooks 校验
      { type: 'date', name: 'revoked_at', required: false },
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE INDEX idx_checkins_activity_participant_status ON checkins (activity_id, participant_id, status)',
      'CREATE INDEX idx_checkins_participant ON checkins (participant_id)',
      'CREATE INDEX idx_checkins_status ON checkins (status)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('checkins');
  return app.delete(collection);
});
