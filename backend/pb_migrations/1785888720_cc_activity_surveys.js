/// <reference path="../pb_data/types.d.ts" />

// 迁移 13：activity_surveys — 活动问卷与独立入口
// 依据：database-design §5.2.14；PRD §8.2、FR-SUR-003/004/006。
// - 一场活动可多份问卷（FR-SUR-003）；复制自模板版本创建，创建后不再随模板升级（AC-13）。
// - 状态机 5 态：draft / not_open / open / ended / archived（§5.5）；开放/结束由管理员手动控制，
//   不被签到状态或时间点强制（PRD §8.2）。
// - qr_token：独立链接/二维码 token，不可连续可猜（PRD §10.3 同类要求），由 hooks 生成。
// API Rules 要点：
// - 机构管理员按机构隔离读写；
// - 参与者不开放直接 list/view：经自定义接口按「登录 + 报名已通过 + 角色匹配 + 状态=open」
//   四条件访问（FR-SUR-006，hooks 实现）；
// - deleteRule 关闭（无硬删除）。开放/结束写审计（PRD §11.3）。

migrate((app) => {
  const activities = app.findCollectionByNameOrId('activities');
  const versions = app.findCollectionByNameOrId('survey_template_versions');

  const collection = new Collection({
    type: 'base',
    name: 'activity_surveys',
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
      // 来源模板版本（复制创建；创建后不再随模板升级）
      {
        type: 'relation',
        name: 'template_version_id',
        required: true,
        collectionId: versions.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      // 活动问卷稳定代码，如 CC_SG_202608_01_PRE（PRD 附录 B）
      { type: 'text', name: 'survey_code', required: true },
      { type: 'text', name: 'title', required: true },
      // 适用角色；访问时按报名 activity_role 校验（FR-SUR-004）
      { type: 'select', name: 'role_scope', required: true, maxSelect: 1, values: ['speaker', 'listener', 'both'] },
      {
        type: 'select',
        name: 'status',
        required: true,
        maxSelect: 1,
        values: ['draft', 'not_open', 'open', 'ended', 'archived'],
      },
      { type: 'text', name: 'qr_token', required: true }, // 独立链接/二维码 token
      { type: 'date', name: 'opened_at', required: false }, // 开放时间（管理员手动控制）
      { type: 'date', name: 'ended_at', required: false }, // 结束时间（管理员手动控制）
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_activity_surveys_survey_code ON activity_surveys (survey_code)',
      'CREATE UNIQUE INDEX idx_activity_surveys_qr_token ON activity_surveys (qr_token)',
      'CREATE INDEX idx_activity_surveys_activity_status ON activity_surveys (activity_id, status)',
      'CREATE INDEX idx_activity_surveys_status ON activity_surveys (status)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('activity_surveys');
  return app.delete(collection);
});
