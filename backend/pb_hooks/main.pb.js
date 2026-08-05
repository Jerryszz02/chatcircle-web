// Chat Circles — PocketBase JS hooks 入口（M0 占位）
//
// 约定（technical-design §5.2/§5.5）：
// - 全部服务端业务规则只写在 pb_hooks/ 与 collection API rules，按领域分文件，
//   共享函数放 pb_hooks/lib/（auth.pb.js / registrations.pb.js / checkins.pb.js /
//   surveys.pb.js / exports.pb.js / metrics.pb.js 等，随里程碑逐步落地）。
// - schema 变更只能经 pb_migrations/，禁止生产环境手工改库。
//
// 本文件当前仅注册一个健康检查端点，作为 hooks 可运行的证明。
// 注意：/api/health 为 PocketBase 内置路由，自定义端点统一使用 /api/cc/* 前缀。

routerAdd('GET', '/api/cc/health', (e) => {
  return e.json(200, { ok: true });
});
