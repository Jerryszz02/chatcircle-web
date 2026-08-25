// posts.pb.js — 内容推文校验与审计 hooks（2026-08 后端改版，PRD 外扩展，AC-25）
//
// 契约（technical-design §5.5、database-design §5.2.24）：
// - posts 为独立内容模块，与 activities 完全无关；仅超管可写（集合 API rules 已限定
//   _superusers），公开端仅见 status='visible'；deleteRule 关闭（无硬删除，隐藏即删除）。
// - 本文件强制：
//   1) 正文（body_md）与外链（external_url）至少填一个，全空 → 400；
//   2) external_url 非空时仅允许 http/https（防 javascript: 等协议注入）；
//   3) status 首次变为 visible 且 published_at 为空时写入当前时间，之后不因隐藏/再可见而改；
//   4) 创建/更新写审计（post.create / post.update，metadata 带 status 迁移）。
// - Markdown 原文存储，消毒在渲染端（前端责任，见 database-design §5.2.24）。
// ⚠️ 本文件为「handler 自包含」模式（PocketBase 0.28.4 实测约束，详见 auth.pb.js 头注释）。

// ---------------------------------------------------------------------------
// 校验与 published_at：挂在模型钩子上（0.28.4 实测：请求钩子里对 e.record 的 set 不落库，
// 模型钩子的 set 随 save 生效——同 activities.pb.js 签到 token 的写法）；
// API 写入与程序化更新一视同仁（posts 写入口本就仅超管 API）。
// ---------------------------------------------------------------------------
onRecordCreate((e) => {
  const ccNow = () => new Date().toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  const record = e.record;
  // status 未显式传入时默认 hidden（select 无默认值机制；可见即发布的语义由调用方显式选择）
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
  // （0.28.4 实测：date 字段空值 get() 返回 truthy 的零值对象，须 String 归一化后判空）
  if (record.get('status') === 'visible' && String(record.get('published_at') || '') === '') {
    record.set('published_at', ccNow());
  }
  e.next();
}, 'posts');

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
  // published_at 只在首次置 visible 时写入，之后不因隐藏/再可见而改（判空同上须 String 归一化）
  const original = record.original();
  if (original && original.id && original.get('status') !== 'visible' &&
      record.get('status') === 'visible' && String(record.get('published_at') || '') === '') {
    record.set('published_at', ccNow());
  }
  e.next();
}, 'posts');

// ---------------------------------------------------------------------------
// 审计：挂在请求钩子上（模型钩子无 e.auth 上下文）；e.next() 成功后写
// post.create / post.update（metadata 带 status 迁移），与现有审计契约同源
// ---------------------------------------------------------------------------
onRecordCreateRequest((e) => {
  // 写一条审计日志（与 lib/audit.pb.js 同源；事务内传 txApp，同事务提交）
  const writeAudit = (app, entry) => {
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
  };
  e.next();
  writeAudit($app, {
    actorId: e.auth ? e.auth.id : '',
    actorRole: 'super_admin',
    action: 'post.create',
    targetType: 'post',
    targetId: e.record.id,
    result: 'success',
    metadata: { status: e.record.get('status') },
  });
}, 'posts');

onRecordUpdateRequest((e) => {
  // 写一条审计日志（与 lib/audit.pb.js 同源；事务内传 txApp，同事务提交）
  const writeAudit = (app, entry) => {
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
  };
  const original = e.record.original();
  const statusChanged = original && original.id && original.get('status') !== e.record.get('status');
  e.next();
  writeAudit($app, {
    actorId: e.auth ? e.auth.id : '',
    actorRole: 'super_admin',
    action: 'post.update',
    targetType: 'post',
    targetId: e.record.id,
    result: 'success',
    metadata: statusChanged
      ? { status: { from: original.get('status'), to: e.record.get('status') } }
      : { status: e.record.get('status') },
  });
}, 'posts');
