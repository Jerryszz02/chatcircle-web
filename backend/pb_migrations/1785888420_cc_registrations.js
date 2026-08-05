/// <reference path="../pb_data/types.d.ts" />

// 迁移 08：registrations — 报名、角色与审核状态
// 依据：database-design §5.2.8；PRD §4.4、FR-REG-002~008。
// - 参与者×活动唯一：复合唯一索引 (activity_id, participant_id)（FR-REG-003）；
//   重复进入由应用层返回现有状态而非新建（幂等，AC-20）。
// - 活动内角色存于报名，不写入账号（FR-REG-002）：speaker=倾诉者 / listener=聆听者。
// - 状态机 4 态与迁移矩阵见 database-design §5.5，矩阵外迁移由 hooks 一律拒绝；
//   状态变更走服务端事务（名额硬校验 + 审计，§5.6）。
// - 不冗余 organization_id：规则经 activity_id.organization_id 一级反查（待确认 D-7，可按评审结论演进）。
// API Rules 要点：
// - 参与者只能 create（服务端强制写入本人 participant_id + 初始 status=pending）与 view/list 本人记录；
// - 不允许参与者 update（提交后不可改，FR-REG-004）；
// - 管理员按机构隔离读写；deleteRule 关闭（无硬删除）。

migrate((app) => {
  const activities = app.findCollectionByNameOrId('activities');
  const participantAccounts = app.findCollectionByNameOrId('participant_accounts');

  const collection = new Collection({
    type: 'base',
    name: 'registrations',
    listRule: '@request.auth.organization_id = activity_id.organization_id || @request.auth.id = participant_id',
    viewRule: '@request.auth.organization_id = activity_id.organization_id || @request.auth.id = participant_id',
    createRule: "@request.auth.id = participant_id && status = 'pending'",
    updateRule: '@request.auth.organization_id = activity_id.organization_id',
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
      // 报名人；「我的」中心按此查本人全部报名（FR-PAR-001）
      {
        type: 'relation',
        name: 'participant_id',
        required: true,
        collectionId: participantAccounts.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      { type: 'select', name: 'activity_role', required: true, maxSelect: 1, values: ['speaker', 'listener'] },
      // pending=待审核 / approved=已通过 / rejected=已拒绝 / cancelled=已取消（无候补态，PRD §4.4）
      {
        type: 'select',
        name: 'status',
        required: true,
        maxSelect: 1,
        values: ['pending', 'approved', 'rejected', 'cancelled'],
      },
      { type: 'date', name: 'submitted_at', required: true }, // 提交时间（幂等判定参考字段之一，AC-20）
      // 最近一次状态变更原因（取消/回退必填，FR-REG-008）；完整历史在 audit_logs
      { type: 'text', name: 'status_reason', required: false },
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      // 同一参与者同一活动仅一条报名记录（FR-REG-003）
      'CREATE UNIQUE INDEX idx_registrations_activity_participant ON registrations (activity_id, participant_id)',
      'CREATE INDEX idx_registrations_activity_status ON registrations (activity_id, status)',
      'CREATE INDEX idx_registrations_participant ON registrations (participant_id)',
      'CREATE INDEX idx_registrations_status ON registrations (status)',
      'CREATE INDEX idx_registrations_role ON registrations (activity_role)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('registrations');
  return app.delete(collection);
});
