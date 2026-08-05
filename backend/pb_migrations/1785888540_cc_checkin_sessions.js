/// <reference path="../pb_data/types.d.ts" />

// 迁移 10：checkin_sessions — 签到开放状态
// 依据：database-design §5.2.10；PRD §5.5、FR-CHK-001/002。
// - 「未开放」不建行：活动无 open 记录即为未开放；每次「开放签到」新建一行，关闭时置 closed（可重复开放/关闭）。
// - 约束：同一活动同一时间至多一条 open 记录 —— SQLite 无法表达该部分唯一，由服务端 hooks 事务保证（§5.6）。
// - 固定二维码 token 在 activities.checkin_qr_token；本表只表达开放窗口。
// API Rules 要点：机构管理员按机构隔离读写（开放/关闭操作）；参与者不直接读本表
// （自助签到与开放状态查询走 hooks 自定义端点，technical-design §5.5）；deleteRule 关闭。
// 开放/关闭写审计（PRD §11.3），由 hooks 完成。

migrate((app) => {
  const activities = app.findCollectionByNameOrId('activities');

  const collection = new Collection({
    type: 'base',
    name: 'checkin_sessions',
    listRule: '@request.auth.organization_id = activity_id.organization_id',
    viewRule: '@request.auth.organization_id = activity_id.organization_id',
    createRule: '@request.auth.organization_id = activity_id.organization_id',
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
      // open=已开放 / closed=已关闭
      { type: 'select', name: 'status', required: true, maxSelect: 1, values: ['open', 'closed'] },
      { type: 'date', name: 'opened_at', required: true },
      { type: 'date', name: 'closed_at', required: false },
      { type: 'text', name: 'opened_by', required: true }, // 操作管理员 id
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: ['CREATE INDEX idx_checkin_sessions_activity_status ON checkin_sessions (activity_id, status)'],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('checkin_sessions');
  return app.delete(collection);
});
