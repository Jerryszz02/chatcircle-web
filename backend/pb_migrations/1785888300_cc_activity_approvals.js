/// <reference path="../pb_data/types.d.ts" />

// 迁移 06：activity_approvals — 活动发布审核历史
// 依据：database-design §5.2.6；PRD §4.3。
// - 只追加不修改（历史表）；下架不经过本表，直接改活动状态并写审计。
// API Rules 要点：机构管理员只读本机构活动的审核记录（经 activity_id.organization_id 反查）；
// 写入仅服务端（管理员 submit / 超管 approve/reject 均走 hooks，technical-design §5.5）；
// update/delete 关闭（不可变 + 无硬删除）。

migrate((app) => {
  const activities = app.findCollectionByNameOrId('activities');

  const collection = new Collection({
    type: 'base',
    name: 'activity_approvals',
    listRule: '@request.auth.organization_id = activity_id.organization_id',
    viewRule: '@request.auth.organization_id = activity_id.organization_id',
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
      // 审核人（超级管理员 id）；提交动作时为提交的管理员 id
      { type: 'text', name: 'reviewer_id', required: true },
      // submit=提交 / approve=批准 / reject=驳回
      { type: 'select', name: 'action', required: true, maxSelect: 1, values: ['submit', 'approve', 'reject'] },
      { type: 'text', name: 'reason', required: false }, // 驳回必填原因（PRD §4.3），由 hooks 校验
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: ['CREATE INDEX idx_activity_approvals_activity ON activity_approvals (activity_id)'],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('activity_approvals');
  return app.delete(collection);
});
