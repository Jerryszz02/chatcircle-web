// Chat Circles — reports.pb.js：报告集合服务端钩子
// 职责：
// - onRecordCreateRequest：created_by 强制 = 当前登录身份 id（忽略客户端传入，服务端归因，
//   同 export_jobs.created_by 约定）；reports rules 全 null，仅超管可创建（agent 服务账号
//   或人工 admin UI 操作）。
// - onRecordCreate：创建审计（report.upload）与报告保存在**同一事务**内写入——模型钩子在
//   保存事务中执行，审计写失败抛错即整体回滚（不会出现「报告已落库但审计缺失」的中间态）。
//
// 实现说明（PocketBase 0.28 JSVM 实测）：handler 在请求期以全新作用域执行，文件级函数/常量
// 对 handler 不可见，故两个 handler 各自自包含（与 guards.pb.js 同模式）。

// created_by 服务端强制填充（客户端传入无效）
onRecordCreateRequest((e) => {
  if (e.auth) {
    e.record.set('created_by', e.auth.id);
  }
  e.next();
}, 'reports');

// 创建审计（report.upload）：与报告保存同事务，失败抛错回滚
onRecordCreate((e) => {
  const collection = e.app.findCollectionByNameOrId('audit_logs');
  const audit = new Record(collection);
  const actorId = e.record.get('created_by') || '';
  audit.set('actor_id', actorId);
  // reports 仅超管可写（rules 全 null），创建者角色恒为 super_admin
  audit.set('actor_role', 'super_admin');
  // 机构归属经活动反查（报告自身不带 organization_id）
  let orgId = '';
  const activityId = e.record.get('activity_id');
  if (activityId) {
    try {
      orgId = e.app.findRecordById('activities', activityId).get('organization_id');
    } catch (_) {
      orgId = '';
    }
  }
  if (orgId) audit.set('organization_id', orgId);
  audit.set('action', 'report.upload');
  audit.set('target_type', 'reports');
  audit.set('target_id', e.record.id);
  audit.set('result', 'success');
  audit.set('metadata', {
    title: e.record.get('title'),
    activity_id: activityId || '',
    export_job_id: e.record.get('export_job_id') || '',
    file: e.record.get('file') || '',
  });
  e.app.save(audit); // 抛错则报告创建一并回滚（同事务）
  e.next();
}, 'reports');
