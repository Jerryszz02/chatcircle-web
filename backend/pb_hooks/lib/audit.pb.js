// lib/audit.pb.js — 统一审计写入（writeAudit）
//
// 契约（technical-design §5.5、security-privacy §8、database-design §5.2.19）：
// - 全部高风险操作在高风险点写入 audit_logs，且与业务写操作同事务：
//   调用方在 runInTransaction 回调内把 txApp 作为 app 传入即可。
// - 审计事件清单（security-privacy §8.1）要求的动作代码由各领域 hooks 约定，
//   本函数不做白名单校验（PRD 未给动作代码表，待确认 D-6，随代码冻结）。
// - metadata 不得含密码或完整敏感答案（PRD §11.2），由调用方保证。
//
//
// ⚠️ 重要集成说明（PocketBase 0.28.4 实测）：JSVM 各 hooks 文件作用域完全隔离，
// 顶层 var/function/const/globalThis 均不跨文件可见，亦无 ES module import 支持。
// 因此本文件是契约的「标准源」：各领域 hooks 文件需将所需函数原样内联到本文件内
// （后端 A 的 auth/registrations/checkins/activities.pb.js 与后端 B 均采用该自包含模式）。

/**
 * 写一条审计日志。
 * @param {object} app 事务内传 txApp，事务外传 $app。
 * @param {object} entry
 * @param {string} entry.actorId 操作者 id；系统任务（备份）用 'system'
 * @param {string} entry.actorRole 'super_admin' | 'admin' | 'participant' | 'system'
 * @param {string} [entry.organizationId] 涉事机构 id；平台级事件省略或传 ''
 * @param {string} entry.action 动作代码（如 'registration.status_revert'）
 * @param {string} entry.targetType 被操作对象类型（如 'registration'）
 * @param {string} entry.targetId 被操作对象 id
 * @param {string} entry.result 'success' | 'failure'
 * @param {string} [entry.reason] 高风险操作原因（补签/回退/作废等必填）
 * @param {object} [entry.metadata] 前后状态、上下文（不得含密码/敏感答案明文）
 * @returns {object} 新建的 audit_logs 记录
 */
function writeAudit(app, entry) {
  const collection = app.findCollectionByNameOrId('audit_logs');
  const record = new Record(collection);
  record.set('actor_id', entry.actorId);
  record.set('actor_role', entry.actorRole);
  record.set('organization_id', entry.organizationId || '');
  record.set('action', entry.action);
  record.set('target_type', entry.targetType);
  record.set('target_id', entry.targetId);
  record.set('result', entry.result);
  record.set('reason', entry.reason || '');
  record.set('metadata', entry.metadata || null);
  app.save(record);
  return record;
}
