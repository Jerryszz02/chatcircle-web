/// <reference path="../pb_data/types.d.ts" />

// 迁移 05：activities — 活动主数据与名额
// 依据：database-design §5.2.5；PRD §4.1、§4.3、FR-ACT-001~007。
// - 状态机 7 态：draft / pending_review / rejected / published / closed / taken_down / archived（§5.5）。
// - group_tag 为预留分组/标签字段（可空），V1 不使用（PRD §4.1）。
// - form_config_json：活动级报名字段启用/必填配置草案（database-design 待确认 D-3，PRD 未写死内容）。
// - checkin_qr_token：固定签到二维码 token，全活动周期不变（FR-CHK-001）；有效性由 checkin_sessions 控制。
// API Rules 要点：
// - listRule 仅机构管理员（参与者/未认证为空集）：无公开活动广场（FR-ACT-002）；
// - viewRule 公开详情页：未登录可按 id 查看 published/closed 活动（FR-ACT-003）；
//   已归档活动公开链接是否可访问 PRD 未明确（待确认 D-5），草案不含 archived；
// - create/update 仅本机构管理员；状态机合法性由 hooks 强制（technical-design §5.5）；
// - deleteRule 关闭（无硬删除，FR-AUD-001）。
// bool 约定同迁移 01：required=true 会强制 true，故 bool 一律 required=false。

migrate((app) => {
  const organizations = app.findCollectionByNameOrId('organizations');

  const collection = new Collection({
    type: 'base',
    name: 'activities',
    listRule: '@request.auth.organization_id = organization_id',
    viewRule: "@request.auth.organization_id = organization_id || status = 'published' || status = 'closed'",
    createRule: '@request.auth.organization_id = organization_id',
    updateRule: '@request.auth.organization_id = organization_id',
    deleteRule: null,
    fields: [
      // 机构隔离主键
      {
        type: 'relation',
        name: 'organization_id',
        required: true,
        collectionId: organizations.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      { type: 'text', name: 'title', required: true },
      // 可读稳定代码，建议机构缩写+日期+序号，如 CC_SG_202608_01（PRD 附录 B）
      { type: 'text', name: 'activity_code', required: true },
      { type: 'text', name: 'description', required: false },
      { type: 'text', name: 'location', required: false },
      { type: 'date', name: 'start_time', required: true }, // PRD §9.1 times；单次场次口径（§4.1）
      { type: 'date', name: 'end_time', required: true },
      {
        type: 'select',
        name: 'status',
        required: true,
        maxSelect: 1,
        values: ['draft', 'pending_review', 'rejected', 'published', 'closed', 'taken_down', 'archived'],
      },
      // 名额硬限制；不得低于当前已通过人数（FR-ACT-006），校验在 hooks 事务内执行
      { type: 'number', name: 'capacity_total', required: true, onlyInt: true, min: 0 },
      { type: 'number', name: 'capacity_speaker', required: true, onlyInt: true, min: 0 }, // 倾诉者名额
      { type: 'number', name: 'capacity_listener', required: true, onlyInt: true, min: 0 }, // 聆听者名额
      { type: 'bool', name: 'registration_open', required: false }, // 报名手动开关（FR-ACT-005）
      { type: 'date', name: 'registration_start_at', required: false }, // 报名起止时间；超时后不能新提交
      { type: 'date', name: 'registration_end_at', required: false },
      // 固定签到二维码 token（FR-CHK-001）
      { type: 'text', name: 'checkin_qr_token', required: true },
      // 预留分组/标签字段（可空），V1 不使用（PRD §4.1）
      { type: 'text', name: 'group_tag', required: false },
      // 活动级报名字段启用/必填配置（草案，待确认 D-3）
      { type: 'json', name: 'form_config_json', required: false },
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_activities_activity_code ON activities (activity_code)',
      'CREATE UNIQUE INDEX idx_activities_checkin_qr_token ON activities (checkin_qr_token)',
      'CREATE INDEX idx_activities_org_status ON activities (organization_id, status)',
      'CREATE INDEX idx_activities_status ON activities (status)',
      'CREATE INDEX idx_activities_group_tag ON activities (group_tag)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('activities');
  return app.delete(collection);
});
