/// <reference path="../pb_data/types.d.ts" />

// 迁移 25：admin_accounts 邮箱化（2026-08 后端改版，PRD 外扩展；database-design §5.2.3）
// - passwordAuth.identityFields 追加 email：邮箱+密码与用户名+密码均可登录；
// - 启用 PB 原生 OTP（邮箱验证码登录，验证码有效期 300 秒）；
// - email 字段保持 schema 层 optional：存量测试账号 email 为空串（不破坏存量数据与
//   唯一索引——PB 对空串不触发唯一冲突），注册必填约束由 admin-register hook 强制；
// - 邮箱验证/找回密码走 PB 内置端点，限流与「仅已验证可找回」门控由 mailguard.pb.js 实现；
// - 邮件投递依赖 PB Settings 手工配置 SMTP（technical-design 待确认 #18），未配置时
//   端点可用但发信失败（仅记录，不影响注册主流程）。

migrate((app) => {
  const collection = app.findCollectionByNameOrId('admin_accounts');
  collection.passwordAuth = { enabled: true, identityFields: ['username', 'email'] };
  collection.otp = { enabled: true, duration: 300 };
  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('admin_accounts');
  collection.passwordAuth = { enabled: true, identityFields: ['username'] };
  collection.otp = { enabled: false, duration: 300 };
  return app.save(collection);
});
