/// <reference path="../pb_data/types.d.ts" />

// 迁移 17：export_jobs — 导出任务与文件
// 依据：database-design §5.2.18；PRD §10.3、FR-EXP-003~005。
// - organization_id 为空 = 超级管理员全平台导出；非空 = 机构导出。
// - scope_json 导出范围：{"type":"platform|organization|activity","activity_id"?,"date_range"?}，
//   范围校验在服务端执行（FR-EXP-004）。
// - include_pii=true 为敏感导出：需机构开关 + 二次确认 + 审计（FR-EXP-003、AC-17）。
// - 导出文件不自动失效；下载 URL 不公开、不连续可猜（FR-EXP-005）；
//   file_path 指向受保护目录，仅鉴权后下载（PRD §11.2）。
// API Rules 要点：机构管理员只读本机构导出记录（首段 != '' 防止参与者/未认证命中 ''='' 读到平台级记录）；
// 创建/更新仅服务端（exports hook 端点，technical-design §5.5）；deleteRule 关闭。
// 每次导出（普通/敏感）均写审计（PRD §11.3）。

migrate((app) => {
  const organizations = app.findCollectionByNameOrId('organizations');

  const collection = new Collection({
    type: 'base',
    name: 'export_jobs',
    listRule: "@request.auth.organization_id != '' && @request.auth.organization_id = organization_id",
    viewRule: "@request.auth.organization_id != '' && @request.auth.organization_id = organization_id",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      // 导出主机构；超级管理员全平台导出时为空
      {
        type: 'relation',
        name: 'organization_id',
        required: false,
        collectionId: organizations.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      { type: 'json', name: 'scope_json', required: true }, // 导出范围（范围校验在服务端，FR-EXP-004）
      { type: 'bool', name: 'include_pii', required: false }, // 是否敏感导出（FR-EXP-003）
      { type: 'text', name: 'file_path', required: true }, // ZIP 存放路径（受保护目录）
      { type: 'text', name: 'file_checksum', required: false }, // 文件校验信息（PRD §10.3）
      { type: 'select', name: 'status', required: true, maxSelect: 1, values: ['running', 'done', 'failed'] },
      { type: 'text', name: 'created_by', required: true }, // 导出人 id（PRD §10.3）
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE INDEX idx_export_jobs_organization ON export_jobs (organization_id)',
      'CREATE INDEX idx_export_jobs_include_pii ON export_jobs (include_pii)',
      'CREATE INDEX idx_export_jobs_created_by ON export_jobs (created_by)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('export_jobs');
  return app.delete(collection);
});
