/// <reference path="../pb_data/types.d.ts" />

// 迁移 20：启用 trusted proxy headers（信任 X-Forwarded-For）
// 依据：docs/security-hardening-2026-08.md §4-1；security-privacy §5.2。
// 背景：生产拓扑中 PB 只被 Caddy 反代访问（compose 中 8090 仅绑回环 +
// 容器内网），Caddyfile 已用 header_up 覆盖客户端伪造的 XFF，因此信任
// XFF 是安全的。不启用时 e.realIP() 恒为 Caddy 容器地址，全部 per-IP
// 限流（authguard/auth/exports）退化为全平台共享桶，正常用户互相误伤。
// 注意：settings 存于 _params 表而非 schema，本迁移是「配置即代码」，
// 避免上线后在控制台手工配置遗漏；本地开发直连模式下 XFF 可伪造，
// 仅影响开发环境限流精度，可接受。

migrate((app) => {
  const settings = app.settings();
  settings.trustedProxy.headers = ['X-Forwarded-For'];
  return app.save(settings);
}, (app) => {
  const settings = app.settings();
  settings.trustedProxy.headers = [];
  return app.save(settings);
});
