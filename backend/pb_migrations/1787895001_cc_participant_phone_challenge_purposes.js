/// <reference path="../pb_data/types.d.ts" />

// T2：参与者认证字段取值扩展。
// - participant_phone_challenges.purpose 新增 register / reset_password 两种用途
//   （register=用户名+密码+手机号注册、reset_password=手机号验证码重置密码）。
// - participant_accounts.phone_binding_source 新增 password_signup（注册来源）。
// 已应用过 1787895000 的存量库需要本迁移扩展这些 select 字段的取值。
// down：恢复为 T1 取值（存量库若已写入新取值记录，会因 next valid value 校验被拒，
// 属可接受的降级风险；业务侧该场景活跃记录极少）。

migrate(
  (app) => {
    const challenges = app.findCollectionByNameOrId('participant_phone_challenges');
    const purpose = challenges.fields.getByName('purpose');
    if (purpose) {
      purpose.values = ['login_or_register', 'register', 'reset_password', 'bind_phone', 'change_phone'];
    }
    app.save(challenges);

    const participants = app.findCollectionByNameOrId('participant_accounts');
    const source = participants.fields.getByName('phone_binding_source');
    if (source) {
      source.values = ['sms_signup', 'password_signup', 'legacy_bind', 'manual_merge'];
    }
    app.save(participants);
  },
  (app) => {
    const challenges = app.findCollectionByNameOrId('participant_phone_challenges');
    const purpose = challenges.fields.getByName('purpose');
    if (purpose) {
      purpose.values = ['login_or_register', 'bind_phone', 'change_phone'];
    }
    app.save(challenges);

    const participants = app.findCollectionByNameOrId('participant_accounts');
    const source = participants.fields.getByName('phone_binding_source');
    if (source) {
      source.values = ['sms_signup', 'legacy_bind', 'manual_merge'];
    }
    app.save(participants);
  },
);
