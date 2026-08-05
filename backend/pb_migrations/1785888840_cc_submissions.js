/// <reference path="../pb_data/types.d.ts" />

// 迁移 15：submissions — 答卷
// 依据：database-design §5.2.16；PRD §4.5、§5.6、FR-SUR-008~010。
// - 一人一问卷一份答卷：复合唯一索引 (activity_survey_id, participant_id)；
//   草稿→正式提交是同一行的状态变更，不产生第二行（FR-SUR-008、AC-20 幂等）；
//   作废后原记录保留，V1 不支持重填，故复合唯一索引安全。
// - 状态机 3 态：draft=草稿 / submitted=已提交 / voided=已作废（无退回重填，PRD §4.5、§5.6）。
// - 问卷完成数口径 = status=submitted（PRD §7.1）；作废记录常规统计与导出排除。
// API Rules 要点：
// - 参与者 create 仅限本人；update 仅限本人 draft 行（提交后锁定，服务端 hooks 拒绝再改）；
//   本人已提交答案只读（FR-SUR-009）；
// - 管理员按机构隔离读写；作废仅管理员（服务端接口，原因 + 审计，FR-SUR-010）；
// - deleteRule 关闭（无硬删除）。

migrate((app) => {
  const activitySurveys = app.findCollectionByNameOrId('activity_surveys');
  const participantAccounts = app.findCollectionByNameOrId('participant_accounts');
  const registrations = app.findCollectionByNameOrId('registrations');

  const collection = new Collection({
    type: 'base',
    name: 'submissions',
    listRule:
      '@request.auth.organization_id = activity_survey_id.activity_id.organization_id || @request.auth.id = participant_id',
    viewRule:
      '@request.auth.organization_id = activity_survey_id.activity_id.organization_id || @request.auth.id = participant_id',
    createRule: '@request.auth.id = participant_id',
    updateRule:
      "(@request.auth.id = participant_id && status = 'draft') || @request.auth.organization_id = activity_survey_id.activity_id.organization_id",
    deleteRule: null,
    fields: [
      {
        type: 'relation',
        name: 'activity_survey_id',
        required: true,
        collectionId: activitySurveys.id,
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
      // 关联报名（同一活动多份问卷可经此关联，PRD §1.3 数据连续性）
      {
        type: 'relation',
        name: 'registration_id',
        required: true,
        collectionId: registrations.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      { type: 'select', name: 'status', required: true, maxSelect: 1, values: ['draft', 'submitted', 'voided'] },
      { type: 'date', name: 'submitted_at', required: false }, // 正式提交时间；草稿为空
      // 作废操作信息（FR-SUR-010）
      { type: 'text', name: 'voided_by', required: false },
      { type: 'date', name: 'voided_at', required: false },
      { type: 'text', name: 'void_reason', required: false },
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      // 一人一问卷一份答卷（含草稿；草稿到提交为同一行状态变更）
      'CREATE UNIQUE INDEX idx_submissions_survey_participant ON submissions (activity_survey_id, participant_id)',
      'CREATE INDEX idx_submissions_survey_status ON submissions (activity_survey_id, status)',
      'CREATE INDEX idx_submissions_participant ON submissions (participant_id)',
      'CREATE INDEX idx_submissions_registration ON submissions (registration_id)',
      'CREATE INDEX idx_submissions_status ON submissions (status)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('submissions');
  return app.delete(collection);
});
