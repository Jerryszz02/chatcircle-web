// 上线不变量：姓名不可关闭；现场计划只作提示，配对开始后配置不可反转。
onRecordCreate((e) => {
  const record = e.record;
  if (record.get('is_template') && ['draft', 'archived'].indexOf(record.get('status')) < 0)
    throw new BadRequestError('机构模板只能保存为草稿或归档，请从模板创建新活动后发布');
  const field = e.app.findFirstRecordByFilter(
    'registration_field_defs',
    "organization_id = '' && source_type = 'standard' && field_code = 'FULL_NAME'",
  );
  let config = {};
  try {
    config = JSON.parse(String(record.get('form_config_json') || '{}')) || {};
  } catch (_) {
    config = {};
  }
  if (typeof config !== 'object' || Array.isArray(config)) config = {};
  const fields = Array.isArray(config.fields) ? config.fields : [];
  config.fields = fields.filter((f) => f && f.field_def_id !== field.id);
  config.fields.push({ field_def_id: field.id, enabled: true, required: true });
  record.set('form_config_json', config);
  if (
    String(record.original().get('pairing_started_at') || '') &&
    record.get('pairing_enabled') !== record.original().get('pairing_enabled')
  ) {
    throw new BadRequestError('配对开始后不可更改配对开关');
  }
  const planned = String(record.get('planned_checkin_at') || '');
  if (planned && planned > String(record.get('end_time')))
    throw new BadRequestError('预计签到开放时间不得晚于活动结束');
  e.next();
}, 'activities');
onRecordUpdate((e) => {
  const record = e.record;
  if (record.get('is_template') && ['draft', 'archived'].indexOf(record.get('status')) < 0)
    throw new BadRequestError('机构模板只能保存为草稿或归档，请从模板创建新活动后发布');
  const field = e.app.findFirstRecordByFilter(
    'registration_field_defs',
    "organization_id = '' && source_type = 'standard' && field_code = 'FULL_NAME'",
  );
  let config = {};
  try {
    config = JSON.parse(String(record.get('form_config_json') || '{}')) || {};
  } catch (_) {
    config = {};
  }
  if (typeof config !== 'object' || Array.isArray(config)) config = {};
  const fields = Array.isArray(config.fields) ? config.fields : [];
  config.fields = fields.filter((f) => f && f.field_def_id !== field.id);
  config.fields.push({ field_def_id: field.id, enabled: true, required: true });
  record.set('form_config_json', config);
  if (
    String(record.original().get('pairing_started_at') || '') &&
    record.get('pairing_enabled') !== record.original().get('pairing_enabled')
  ) {
    throw new BadRequestError('配对开始后不可更改配对开关');
  }
  const planned = String(record.get('planned_checkin_at') || '');
  if (planned && planned > String(record.get('end_time')))
    throw new BadRequestError('预计签到开放时间不得晚于活动结束');
  e.next();
}, 'activities');

onRecordCreateRequest((e) => {
  if (!Object.prototype.hasOwnProperty.call(e.requestInfo().body || {}, 'pairing_enabled'))
    e.record.set('pairing_enabled', true);
  e.next();
}, 'activities');

onRecordUpdate((e) => {
  const original = e.record.original();
  if (original.get('field_code') === 'FULL_NAME' && !original.get('organization_id')) {
    for (const field of ['field_code', 'organization_id', 'source_type']) {
      if (e.record.get(field) !== original.get(field)) throw new BadRequestError('标准姓名字段身份不可修改');
    }
    e.record.set('field_type', 'text');
    e.record.set('required_default', true);
    e.record.set('is_sensitive', true);
    e.record.set('role_scope', 'both');
    e.record.set('status', 'active');
  }
  e.next();
}, 'registration_field_defs');
