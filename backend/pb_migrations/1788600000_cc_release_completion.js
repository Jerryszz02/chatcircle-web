/// <reference path="../pb_data/types.d.ts" />
// 现场计划为人工操作提示，不自动更改签到/问卷状态。存量活动默认启用配对。
migrate(
  (app) => {
    const activities = app.findCollectionByNameOrId('activities');
    activities.fields.add(new BoolField({ name: 'pairing_enabled' }));
    activities.fields.add(new BoolField({ name: 'is_template' }));
    activities.fields.add(new DateField({ name: 'planned_checkin_at' }));
    app.save(activities);
    app.db().newQuery('UPDATE activities SET pairing_enabled = 1').execute();
    const surveys = app.findCollectionByNameOrId('activity_surveys');
    surveys.fields.add(new SelectField({ name: 'phase', maxSelect: 1, values: ['before', 'onsite', 'after'] }));
    surveys.fields.add(new DateField({ name: 'planned_open_at' }));
    app.save(surveys);
    const admins = app.findCollectionByNameOrId('admin_accounts');
    admins.verificationTemplate = {
      subject: '验证 Chat Circles 管理员邮箱',
      body: '<p>请点击下面的链接验证你的管理员邮箱。如果不是你本人申请，请忽略此邮件。</p><p><a href="{APP_URL}/admin/verify-email#token={TOKEN}">验证邮箱</a></p>',
    };
    admins.resetPasswordTemplate = {
      subject: '重置 Chat Circles 管理员密码',
      body: '<p>请点击下面的链接设置新密码。如果不是你本人申请，请忽略此邮件。</p><p><a href="{APP_URL}/admin/reset-password#token={TOKEN}">重置密码</a></p>',
    };
    app.save(admins);
    // 标准姓名不会由测试/人工播种来保证；升级时幂等创建，保留已有字段 ID 和历史答案。
    const defs = app.findRecordsByFilter(
      'registration_field_defs',
      "organization_id = '' && source_type = 'standard' && field_code = 'FULL_NAME'",
      '',
      1,
    );
    const name = defs[0] || new Record(app.findCollectionByNameOrId('registration_field_defs'));
    if (!defs.length) {
      name.set('field_code', 'FULL_NAME');
      name.set('source_type', 'standard');
      name.set('label', '姓名');
    }
    name.set('field_type', 'text');
    name.set('required_default', true);
    name.set('is_sensitive', true);
    name.set('role_scope', 'both');
    name.set('status', 'active');
    app.save(name);
  },
  (app) => {
    const activities = app.findCollectionByNameOrId('activities');
    activities.fields.removeByName('is_template');
    activities.fields.removeByName('pairing_enabled');
    activities.fields.removeByName('planned_checkin_at');
    app.save(activities);
    const surveys = app.findCollectionByNameOrId('activity_surveys');
    surveys.fields.removeByName('phase');
    surveys.fields.removeByName('planned_open_at');
    app.save(surveys);
    // 姓名字段属于业务数据，降级不删除，以免丢失迁移后收集的答案。
  },
);
