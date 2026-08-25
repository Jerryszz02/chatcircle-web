// posts.pb.js — 内容推文校验与审计 hooks（2026-08 后端改版，PRD 外扩展，AC-25）
//
// 契约（technical-design §5.5、database-design §5.2.24）：
// - posts 为独立内容模块，与 activities 完全无关；仅超管可写（集合 API rules 已限定
//   _superusers），公开端仅见 status='visible'；deleteRule 关闭（无硬删除，隐藏即删除）。
// - 请求钩子（onRecordCreateRequest / onRecordUpdateRequest）：
//   created_by / updated_by 强制 = 当前登录身份 id（忽略客户端传入，服务端归因，
//   同 reports.created_by 约定）。
// - 模型钩子（onRecordCreate / onRecordUpdate，保存事务内执行）：
//   1) status 缺省补 hidden（select 无默认值机制）；
//   2) 正文（body_md）与外链（external_url）至少填一个，全空 → 400；
//   3) external_url 非空时仅允许 http/https（防 javascript: 等协议注入）；
//   4) status 首次变为 visible 且 published_at 为空时写入当前时间，之后不因隐藏/再可见而改；
//   5) 创建/更新审计（post.create / post.update）与推文保存在**同一事务**写入
//      （同 reports.pb.js：审计写失败抛错即整体回滚）。
// - Markdown 原文存储，消毒在渲染端（前端责任，见 database-design §5.2.24）。
// ⚠️ 本文件为「handler 自包含」模式（PocketBase 0.28.4 实测约束，详见 auth.pb.js 头注释）。

// ---------------------------------------------------------------------------
// 归因字段服务端强制填充（客户端传入无效；审计在模型钩子内需要 actor，
// 模型钩子无 e.auth 上下文，故经记录字段传递）
// ---------------------------------------------------------------------------
onRecordCreateRequest((e) => {
  if (e.auth) {
    e.record.set('created_by', e.auth.id);
    e.record.set('updated_by', e.auth.id);
  }
  e.next();
}, 'posts');

onRecordUpdateRequest((e) => {
  if (e.auth) {
    e.record.set('updated_by', e.auth.id);
  }
  e.next();
}, 'posts');

// ---------------------------------------------------------------------------
// 校验 + published_at + 创建审计（同一事务）
// 0.28.4 实测：date 字段空值 get() 返回 truthy 的零值对象，须 String 归一化后判空
// ---------------------------------------------------------------------------
onRecordCreate((e) => {
  const ccNow = () => new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  const record = e.record;
  // status 未显式传入时默认 hidden（可见即发布的语义由调用方显式选择）
  if (String(record.get('status') || '') === '') {
    record.set('status', 'hidden');
  }
  const bodyMd = String(record.get('body_md') || '').trim();
  const externalUrl = String(record.get('external_url') || '').trim();
  if (bodyMd === '' && externalUrl === '') {
    throw new ApiError(400, '正文与外链至少填写一项');
  }
  if (externalUrl !== '' && !/^https?:\/\//i.test(externalUrl)) {
    throw new ApiError(400, '外链仅允许 http/https 协议');
  }
  // 创建即 visible：published_at 缺省写当前时间
  if (record.get('status') === 'visible' && String(record.get('published_at') || '') === '') {
    record.set('published_at', ccNow());
  }
  // 创建审计（post.create）：与推文保存同事务，失败抛错回滚（同 reports.pb.js）
  const collection = e.app.findCollectionByNameOrId('audit_logs');
  const audit = new Record(collection);
  audit.set('actor_id', record.get('created_by') || '');
  audit.set('actor_role', 'super_admin'); // posts 仅超管可写，创建者角色恒定
  audit.set('action', 'post.create');
  audit.set('target_type', 'post');
  audit.set('target_id', record.id);
  audit.set('result', 'success');
  audit.set('metadata', { status: record.get('status') });
  e.app.save(audit);
  e.next();
}, 'posts');

// ---------------------------------------------------------------------------
// 更新校验 + published_at + 更新审计（同一事务；metadata 带 status 迁移）
// ---------------------------------------------------------------------------
onRecordUpdate((e) => {
  const ccNow = () => new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  const record = e.record;
  const bodyMd = String(record.get('body_md') || '').trim();
  const externalUrl = String(record.get('external_url') || '').trim();
  if (bodyMd === '' && externalUrl === '') {
    throw new ApiError(400, '正文与外链至少填写一项');
  }
  if (externalUrl !== '' && !/^https?:\/\//i.test(externalUrl)) {
    throw new ApiError(400, '外链仅允许 http/https 协议');
  }
  // published_at 只在首次置 visible 时写入，之后不因隐藏/再可见而改（判空须 String 归一化）
  const original = record.original();
  if (original && original.id && original.get('status') !== 'visible' &&
      record.get('status') === 'visible' && String(record.get('published_at') || '') === '') {
    record.set('published_at', ccNow());
  }
  // 更新审计（post.update）：与保存同事务；status 迁移记入 metadata
  const statusChanged = original && original.id && original.get('status') !== record.get('status');
  const collection = e.app.findCollectionByNameOrId('audit_logs');
  const audit = new Record(collection);
  audit.set('actor_id', record.get('updated_by') || '');
  audit.set('actor_role', 'super_admin');
  audit.set('action', 'post.update');
  audit.set('target_type', 'post');
  audit.set('target_id', record.id);
  audit.set('result', 'success');
  audit.set('metadata', statusChanged
    ? { status: { from: original.get('status'), to: record.get('status') } }
    : { status: record.get('status') });
  e.app.save(audit);
  e.next();
}, 'posts');
