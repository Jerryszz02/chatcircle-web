/// <reference path="../pb_data/types.d.ts" />

// 迁移 16：answers — 题目答案
// 依据：database-design §5.2.17；PRD §9.2、§10.3。
// - question_code 冗余存储：导出 answers.csv 直接按 question_code 关联，
//   且保证历史答案不受题目后续调整影响（PRD §9.2）。
// - value_json 存答案值；多选用标准 JSON 数组（PRD §10.3）。
// - is_sensitive 由 survey_questions 按 question_code 反查（导出过滤，FR-EXP-002）。
// - 随提交事务写入（submissions 状态切换 + answers 写入同一事务，database-design §5.6）。
// API Rules 要点：
// - 参与者 create/update 仅限本人草稿答卷的答案（提交后锁定，update 规则引 submission 状态）；
// - 管理员按机构隔离只读（三级反查 submission_id.activity_survey_id.activity_id.organization_id）；
// - deleteRule 关闭（无硬删除）。

migrate((app) => {
  const submissions = app.findCollectionByNameOrId('submissions');

  const collection = new Collection({
    type: 'base',
    name: 'answers',
    listRule:
      '@request.auth.organization_id = submission_id.activity_survey_id.activity_id.organization_id || @request.auth.id = submission_id.participant_id',
    viewRule:
      '@request.auth.organization_id = submission_id.activity_survey_id.activity_id.organization_id || @request.auth.id = submission_id.participant_id',
    createRule: '@request.auth.id = submission_id.participant_id',
    updateRule: "@request.auth.id = submission_id.participant_id && submission_id.status = 'draft'",
    deleteRule: null,
    fields: [
      {
        type: 'relation',
        name: 'submission_id',
        required: true,
        collectionId: submissions.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      // 冗余存储题目代码（PRD §9.2）
      { type: 'text', name: 'question_code', required: true },
      { type: 'json', name: 'value_json', required: true },
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      // 同一答卷同一题目仅一条答案
      'CREATE UNIQUE INDEX idx_answers_submission_question ON answers (submission_id, question_code)',
      'CREATE INDEX idx_answers_question_code ON answers (question_code)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('answers');
  return app.delete(collection);
});
