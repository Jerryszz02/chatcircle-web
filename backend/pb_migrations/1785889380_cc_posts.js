/// <reference path="../pb_data/types.d.ts" />

// 迁移 24：posts — 内容推文集合（2026-08 后端改版，PRD 外扩展；database-design §5.2.24）
// - 独立内容模块，与 activities 完全无关：标题/摘要/封面图/Markdown 正文/外链，
//   带置顶与显隐开关；正文与外链至少填一个的约束由 pb_hooks/posts.pb.js 强制。
// - 仅超管可编辑（机构管理员无入口）；公开端仅见 status='visible'。
// API Rules 要点：
// - listRule/viewRule：visible 公开可读（匿名可），超管全量可见；
//   匿名请求下 @request.auth 为空、右侧整体为假（实施探针已验证）；
// - create/update 仅 _superusers；deleteRule 关闭（无硬删除，FR-AUD-001，隐藏即删除）。
// bool 约定同迁移 01：required=true 会强制 true，故 bool 一律 required=false。

migrate((app) => {
  const collection = new Collection({
    type: 'base',
    name: 'posts',
    listRule: "status = 'visible' || @request.auth.collectionName = '_superusers'",
    viewRule: "status = 'visible' || @request.auth.collectionName = '_superusers'",
    createRule: "@request.auth.collectionName = '_superusers'",
    updateRule: "@request.auth.collectionName = '_superusers'",
    deleteRule: null,
    fields: [
      { type: 'text', name: 'title', required: true },
      // 摘要；为空时前端摘取正文前 N 字兜底
      { type: 'text', name: 'summary', required: false },
      // 封面图（单图，可空）；5MB 为暂定值（database-design 待确认 D-9）；文件 URL 随 viewRule 放行
      {
        type: 'file',
        name: 'cover',
        required: false,
        maxSelect: 1,
        maxSize: 5242880, // 5MB
        mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      },
      // Markdown 原文；消毒在渲染端（服务端只存原文，前端渲染时消毒）
      { type: 'text', name: 'body_md', required: false },
      // 外链 URL；非空时仅允许 http/https（posts.pb.js 校验）
      { type: 'text', name: 'external_url', required: false },
      { type: 'bool', name: 'is_pinned', required: false }, // 置顶开关
      // hidden=隐藏 / visible=可见；默认 hidden（hooks 创建时不显式传则按缺省）
      { type: 'select', name: 'status', required: true, maxSelect: 1, values: ['hidden', 'visible'] },
      // 首次置 visible 时由 hooks 写入当前时间，之后不因隐藏/再可见而改
      { type: 'date', name: 'published_at', required: false },
      // 归因字段：服务端钩子强制填充（客户端传入无效），供审计 actor（同 reports.created_by 约定）；
      // hidden=true：仅超管可见，不对公开/普通用户下发（推文为公开读集合，防归因 id 外露）
      { type: 'text', name: 'created_by', required: false, hidden: true },
      { type: 'text', name: 'updated_by', required: false, hidden: true },
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE INDEX idx_posts_status ON posts (status)',
      // 公开列表排序：置顶优先 + 发布时间倒序
      'CREATE INDEX idx_posts_pin_published ON posts (is_pinned, published_at)',
    ],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('posts');
  return app.delete(collection);
});
