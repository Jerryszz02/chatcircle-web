/// <reference path="../pb_data/types.d.ts" />

// 迁移 20：activities 安全加固 schema 调整
// - checkin_qr_token 改为 required=false（唯一索引 idx_activities_checkin_qr_token 保留）：
//   改由 activities.pb.js 的 onRecordCreate 模型钩子在创建时生成 24 位随机 token
//   （服务端为唯一生成方），客户端创建活动不再必须自带 token；
// - viewRule 收紧为仅本机构管理员可见：匿名/参与者公开访问一律走
//   /api/cc/public/activities* 白名单端点（字段白名单下发），原生 view 不再按 status
//   放行（防原生 API 直读 published/closed 活动全字段，含 checkin_qr_token）。
// down：恢复 required=true 与原 viewRule。

migrate((app) => {
  const collection = app.findCollectionByNameOrId('activities');
  const field = collection.fields.getByName('checkin_qr_token');
  if (field) field.required = false;
  collection.viewRule = '@request.auth.organization_id = organization_id';
  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('activities');
  const field = collection.fields.getByName('checkin_qr_token');
  if (field) field.required = true;
  collection.viewRule = "@request.auth.organization_id = organization_id || status = 'published' || status = 'closed'";
  return app.save(collection);
});
