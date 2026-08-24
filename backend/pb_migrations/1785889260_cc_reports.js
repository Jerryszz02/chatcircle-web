/// <reference path="../pb_data/types.d.ts" />

// 迁移 21：reports — 活动数据报告（agent 产出物入库）
// 背景：数据分析与报告生成由外部 agent（经 mcp/ MCP server 以超管服务账号接入）完成，
//   本集合承接其产出物；取数仍走 exports hook（POST /api/cc/exports），本集合只做报告存储。
// - activity_id 可空：V1 场景为单活动报告，可空为未来机构/平台级报告留口；
// - export_job_id 溯源：本报告基于哪次导出（exports hook 生成的 export_jobs.id）；
// - status：agent 上传一律 draft（MCP tool 侧强制），人工审核后改 published；
// - created_by：创建人 id，由 reports.pb.js 的 onRecordCreateRequest 强制填充（服务端归因）；
//   创建审计（report.upload）由 onRecordCreate 模型钩子在同一事务内写入（失败即整体回滚）；
// - file protected：报告文件 URL 必须带 token 访问，不走公开静态路径（同 exports 的防护口径）；
// API Rules 要点：全部 null（仅超级管理员经 API / admin UI 可读写）；
//   deleteRule null 同时满足无硬删除的产品面约定（FR-AUD-001）。

migrate((app) => {
  const activities = app.findCollectionByNameOrId('activities');

  const collection = new Collection({
    type: 'base',
    name: 'reports',
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: 'text', name: 'title', required: true }, // 报告标题
      // 所属活动；可空为未来机构/平台级报告留口
      {
        type: 'relation',
        name: 'activity_id',
        required: false,
        collectionId: activities.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      // 报告文件（pdf/md 等）；protected：文件 URL 须带 token
      {
        type: 'file',
        name: 'file',
        required: true,
        maxSelect: 1,
        maxSize: 20971520, // 20MB
        protected: true,
      },
      // agent 上传一律 draft，人工审核后改 published
      { type: 'select', name: 'status', required: true, maxSelect: 1, values: ['draft', 'published'] },
      { type: 'text', name: 'export_job_id', required: false }, // 溯源：基于哪次导出
      { type: 'text', name: 'notes', required: false }, // 生成元信息（skill/prompt 版本等）
      // 创建人 id：服务端钩子强制填充（reports.pb.js onRecordCreateRequest），客户端传入无效，
      // 供审计归因（同 export_jobs.created_by 约定）
      { type: 'text', name: 'created_by', required: false },
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE INDEX idx_reports_activity ON reports (activity_id)',
      'CREATE INDEX idx_reports_status ON reports (status)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('reports');
  return app.delete(collection);
});
