/// <reference path="../pb_data/types.d.ts" />

// 迁移 19：participant_accounts / admin_accounts updateRule 收紧（安全加固）
// - 追加 @request.body.status:isset = false：直连 update 请求体不得携带 status，
//   账号停用/恢复仅超级管理员或服务端 hooks 内部 save（后者不经过 API rules）；
// - admin_accounts 原表达式为多条件，括号包裹后追加；participant_accounts 直接追加。
// 与 pb_hooks/guards.pb.js 的 onRecordUpdateRequest 守卫互为纵深（守卫先于 rule 生效，抛 403）。

migrate((app) => {
  const participantAccounts = app.findCollectionByNameOrId('participant_accounts');
  participantAccounts.updateRule =
    '@request.auth.id = id && (@request.body.username:isset = false || @request.body.username = username) && @request.body.status:isset = false';
  app.save(participantAccounts);

  const adminAccounts = app.findCollectionByNameOrId('admin_accounts');
  adminAccounts.updateRule =
    '(@request.auth.id = id && (@request.body.organization_id:isset = false || @request.body.organization_id = organization_id)) && @request.body.status:isset = false';
  return app.save(adminAccounts);
}, (app) => {
  const participantAccounts = app.findCollectionByNameOrId('participant_accounts');
  participantAccounts.updateRule =
    '@request.auth.id = id && (@request.body.username:isset = false || @request.body.username = username)';
  app.save(participantAccounts);

  const adminAccounts = app.findCollectionByNameOrId('admin_accounts');
  adminAccounts.updateRule =
    '@request.auth.id = id && (@request.body.organization_id:isset = false || @request.body.organization_id = organization_id)';
  return app.save(adminAccounts);
});
