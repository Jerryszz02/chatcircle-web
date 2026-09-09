/// <reference path="../pb_data/types.d.ts" />

// F02：集合 API 的停用边界必须在每次请求重新评估。
// PocketBase 会验证 token 的签名/有效期，但不会把项目 authRule 自动附加到
// list/view/expand/file/realtime 的集合规则；因此把 active 约束追加到所有带
// @request.auth 的业务规则。公开文章仍由其原有公开规则控制。
migrate((app) => {
  const activeAuth =
    "(@request.auth.status = 'active' && (@request.auth.collectionName = 'participant_accounts' || (@request.auth.collectionName = 'admin_accounts' && @request.auth.organization_id.status = 'active')))";
  const superBypass = "@request.auth.collectionName = '_superusers'";
  const publicCollections = ['posts'];
  const collections = app.findAllCollections();
  for (const collection of collections) {
    if (collection.system || collection.name === 'users' || publicCollections.indexOf(collection.name) >= 0) continue;
    for (const field of ['listRule', 'viewRule', 'createRule', 'updateRule', 'deleteRule']) {
      const rule = collection[field] == null ? null : String(collection[field]);
      if (typeof rule !== 'string' || rule.indexOf('@request.auth') < 0) continue;
      if (rule.indexOf(activeAuth) >= 0) continue;
      collection[field] = superBypass + ' || ((' + rule + ') && ' + activeAuth + ')';
    }
    app.save(collection);
  }
}, (app) => {
  const activeAuth =
    "(@request.auth.status = 'active' && (@request.auth.collectionName = 'participant_accounts' || (@request.auth.collectionName = 'admin_accounts' && @request.auth.organization_id.status = 'active')))";
  const superBypass = "@request.auth.collectionName = '_superusers'";
  for (const collection of app.findAllCollections()) {
    if (collection.system || collection.name === 'users' || collection.name === 'posts') continue;
    for (const field of ['listRule', 'viewRule', 'createRule', 'updateRule', 'deleteRule']) {
      const rule = collection[field] == null ? null : String(collection[field]);
      const prefix = superBypass + ' || ((';
      const suffix = ') && ' + activeAuth + ')';
      if (typeof rule === 'string' && rule.indexOf(prefix) === 0 && rule.endsWith(suffix)) {
        collection[field] = rule.slice(prefix.length, -suffix.length);
      }
    }
    app.save(collection);
  }
});
