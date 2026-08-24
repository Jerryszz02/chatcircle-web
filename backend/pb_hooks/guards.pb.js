// guards.pb.js — 集合直连写守卫（安全加固）
//
// 本文件是各业务集合「直连写唯一拦截点」：非超级管理员经 /api/collections/{name}/records
// 的直连写一律在此拦截或收窄，业务写操作必须走 /api/cc/* 自定义端点，保证资格校验、
// 状态机与事务语义为唯一服务端强制点（technical-design §5.5）。超级管理员放行（运维/测试场景）。
//
// ⚠️ 新增业务集合时必须同步评估是否在此追加守卫；集合字段变更时同步复核禁改清单。
// ⚠️ 本文件为「handler 自包含」模式（PocketBase 0.28.4 实测约束，详见 auth.pb.js 头注释）：
// 各 handler 只能使用自身闭包内标识符与 JSVM 内建全局（ForbiddenError 等），超级管理员
// 判定在每个 handler 内就地展开，勿提取为跨 handler 共享函数。
// 禁改比对用 e.record.original()，值不变则放行；0.28.4 实测 onRecordCreateRequest /
// onRecordUpdateRequest 触发时 e.record 已携带请求数据。
//
// 守卫清单：
// - activities：创建强制 status='draft'；更新禁改 status / organization_id / checkin_qr_token
// - trainings：创建强制 status='draft'；更新禁改 status / organization_id / checkin_qr_token
// - registrations / registration_answers：禁直连 create/update（走报名与审核端点）
// - checkin_sessions：禁直连 create/update（走签到开放/关闭端点）
// - training_checkin_sessions / training_attendances：禁直连 create/update（走培训签到端点）
// - registration_field_defs：更新禁改 organization_id / field_code
// - participant_accounts：更新禁改 status
// - admin_accounts：更新禁改 status / organization_id
//
// 说明：onRecord*Request 仅在 HTTP 直连请求时触发，hooks 内部 app.save 不触发本守卫；
// PB 内置 auth-with-password / auth-refresh 不产生 update 请求（0.28.4 实测），无需特殊放行。

// ---------------------------------------------------------------------------
// activities：创建强制 draft 起步；状态机流转、机构归属与签到 token 禁经直连修改
// ---------------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper && e.record.get('status') !== 'draft') {
    throw new ForbiddenError('活动创建时 status 必须为 draft（状态流转须通过 /api/cc/activities/{id}/submit-review|publish 等状态端点）');
  }
  e.next();
}, 'activities');

onRecordUpdateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    const original = e.record.original();
    if (original.get('status') !== e.record.get('status')) {
      throw new ForbiddenError('活动状态变更须通过 /api/cc/activities/{id}/submit-review|publish|close|archive 等状态端点');
    }
    if (original.get('organization_id') !== e.record.get('organization_id')) {
      throw new ForbiddenError('活动所属机构（organization_id）不可变更');
    }
    if (original.get('checkin_qr_token') !== e.record.get('checkin_qr_token')) {
      throw new ForbiddenError('签到二维码 token（checkin_qr_token）不可变更');
    }
  }
  e.next();
}, 'activities');

// ---------------------------------------------------------------------------
// registrations / registration_answers：禁直连写（报名与答案随报名事务写入，
// 状态变更走审核端点）
// ---------------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('报名写操作须通过 /api/cc/activities/{id}/register 与 /api/cc/registrations/{id}/transition 端点');
  }
  e.next();
}, 'registrations');
onRecordUpdateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('报名写操作须通过 /api/cc/activities/{id}/register 与 /api/cc/registrations/{id}/transition 端点');
  }
  e.next();
}, 'registrations');

onRecordCreateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('报名答案写操作须通过 /api/cc/activities/{id}/register 端点');
  }
  e.next();
}, 'registration_answers');
onRecordUpdateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('报名答案写操作须通过 /api/cc/activities/{id}/register 端点');
  }
  e.next();
}, 'registration_answers');

// ---------------------------------------------------------------------------
// checkin_sessions：禁直连写（开放/关闭须走端点保证单 open 约束与审计）
// ---------------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('签到开放状态写操作须通过 /api/cc/activities/{id}/checkin/open|close 端点');
  }
  e.next();
}, 'checkin_sessions');
onRecordUpdateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('签到开放状态写操作须通过 /api/cc/activities/{id}/checkin/open|close 端点');
  }
  e.next();
}, 'checkin_sessions');

// ---------------------------------------------------------------------------
// trainings：创建强制 draft 起步；状态机流转、机构归属与签到 token 禁经直连修改
// ---------------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper && e.record.get('status') !== 'draft') {
    throw new ForbiddenError('培训创建时 status 必须为 draft（状态流转须通过 /api/cc/trainings/{id}/publish|close 端点）');
  }
  e.next();
}, 'trainings');

onRecordUpdateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    const original = e.record.original();
    if (original.get('status') !== e.record.get('status')) {
      throw new ForbiddenError('培训状态变更须通过 /api/cc/trainings/{id}/publish|close 状态端点');
    }
    if (original.get('organization_id') !== e.record.get('organization_id')) {
      throw new ForbiddenError('培训所属机构（organization_id）不可变更');
    }
    if (original.get('checkin_qr_token') !== e.record.get('checkin_qr_token')) {
      throw new ForbiddenError('培训签到二维码 token（checkin_qr_token）不可变更');
    }
  }
  e.next();
}, 'trainings');

// ---------------------------------------------------------------------------
// training_checkin_sessions / training_attendances：禁直连写（开放/关闭与
// 签到/补签/撤销须走端点保证单 open 约束、幂等查重与审计）
// ---------------------------------------------------------------------------
onRecordCreateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('培训签到开放状态写操作须通过 /api/cc/trainings/{id}/checkin/open|close 端点');
  }
  e.next();
}, 'training_checkin_sessions');
onRecordUpdateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('培训签到开放状态写操作须通过 /api/cc/trainings/{id}/checkin/open|close 端点');
  }
  e.next();
}, 'training_checkin_sessions');

onRecordCreateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('培训签到写操作须通过 /api/cc/training-checkin/self、/api/cc/training-checkins/manual|{id}/revoke 端点');
  }
  e.next();
}, 'training_attendances');
onRecordUpdateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    throw new ForbiddenError('培训签到写操作须通过 /api/cc/training-checkin/self、/api/cc/training-checkins/manual|{id}/revoke 端点');
  }
  e.next();
}, 'training_attendances');

// ---------------------------------------------------------------------------
// registration_field_defs：机构归属与稳定机器代码禁改
// ---------------------------------------------------------------------------
onRecordUpdateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    const original = e.record.original();
    if (original.get('organization_id') !== e.record.get('organization_id')) {
      throw new ForbiddenError('字段所属机构（organization_id）不可变更');
    }
    if (original.get('field_code') !== e.record.get('field_code')) {
      throw new ForbiddenError('field_code 为稳定机器字段，不可变更');
    }
  }
  e.next();
}, 'registration_field_defs');

// ---------------------------------------------------------------------------
// participant_accounts / admin_accounts：账号状态禁经直连修改
// （停用/恢复仅超级管理员或服务端 hooks 内部 save）
// ---------------------------------------------------------------------------
onRecordUpdateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper && e.record.original().get('status') !== e.record.get('status')) {
    throw new ForbiddenError('参与者账号状态（status）不可经直连 API 修改');
  }
  e.next();
}, 'participant_accounts');

onRecordUpdateRequest((e) => {
  const isSuper = !!e.auth && e.auth.collection().name === '_superusers';
  if (!isSuper) {
    const original = e.record.original();
    if (original.get('status') !== e.record.get('status')) {
      throw new ForbiddenError('管理员账号状态（status）不可经直连 API 修改');
    }
    if (original.get('organization_id') !== e.record.get('organization_id')) {
      throw new ForbiddenError('管理员所属机构（organization_id）不可变更');
    }
  }
  e.next();
}, 'admin_accounts');
