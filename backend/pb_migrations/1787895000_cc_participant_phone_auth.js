/// <reference path="../pb_data/types.d.ts" />

// T1：参与者手机号账号 + 短信验证码 challenge（专项 PRD §3、API 契约 §3）。
//
// participant_accounts：
// - 完整手机号与查找 HMAC 均为 hidden，客户端不能经 auth/record API 读取；
// - 非空 phone_lookup_hash 唯一，保证同一手机号至多绑定一个参与者；
// - 存量账号回填 legacy_unbound；username/password 继续保留给迁移入口。
//
// participant_phone_challenges：
// - 内部集合，全部 API rules 关闭，只由 phoneauth.pb.js 读写；
// - 不存完整手机号与验证码，只存手机号 HMAC、用途、绑定账号、状态与 provider request id；
// - 持久化 challenge 使验证码消费与账号写入可在同一事务内完成，避免并发双消费。

migrate((app) => {
  const participants = app.findCollectionByNameOrId('participant_accounts');
  participants.fields.add(new Field({
    type: 'text',
    name: 'phone_e164',
    required: false,
    hidden: true,
  }));
  participants.fields.add(new Field({
    type: 'text',
    name: 'phone_lookup_hash',
    required: false,
    hidden: true,
  }));
  participants.fields.add(new Field({
    type: 'date',
    name: 'phone_verified_at',
    required: false,
  }));
  participants.fields.add(new Field({
    type: 'select',
    name: 'phone_binding_source',
    required: false,
    maxSelect: 1,
    values: ['sms_signup', 'legacy_bind', 'manual_merge'],
  }));
  participants.fields.add(new Field({
    type: 'select',
    name: 'phone_migration_status',
    required: false,
    maxSelect: 1,
    values: ['legacy_unbound', 'phone_bound', 'merge_required'],
  }));
  participants.indexes = participants.indexes.concat([
    "CREATE UNIQUE INDEX idx_participant_phone_lookup_hash ON participant_accounts (phone_lookup_hash) WHERE phone_lookup_hash != ''",
  ]);
  app.save(participants);

  const existing = app.findRecordsByFilter(
    'participant_accounts',
    "phone_migration_status = ''",
    '',
    5000,
    0,
  );
  for (const participant of existing) {
    participant.set('phone_migration_status', 'legacy_unbound');
    app.save(participant);
  }

  const challenges = new Collection({
    type: 'base',
    name: 'participant_phone_challenges',
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: 'text', name: 'phone_lookup_hash', required: true, hidden: true },
      {
        type: 'select',
        name: 'purpose',
        required: true,
        maxSelect: 1,
        values: ['login_or_register', 'bind_phone', 'change_phone'],
      },
      {
        type: 'select',
        name: 'change_role',
        required: false,
        maxSelect: 1,
        values: ['old', 'new'],
      },
      {
        type: 'relation',
        name: 'participant_id',
        required: false,
        collectionId: participants.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      {
        type: 'select',
        name: 'status',
        required: true,
        maxSelect: 1,
        values: ['pending', 'sent', 'consumed', 'failed'],
      },
      { type: 'select', name: 'provider', required: true, maxSelect: 1, values: ['aliyun', 'mock'] },
      { type: 'text', name: 'privacy_notice_version', required: false },
      { type: 'text', name: 'provider_request_id', required: false, hidden: true },
      // PocketBase 将数值 0 视作 required 空值；保持非必填并由 hook 始终显式写 0。
      { type: 'number', name: 'attempt_count', required: false, onlyInt: true, min: 0 },
      { type: 'date', name: 'expires_at', required: true },
      { type: 'date', name: 'sent_at', required: false },
      { type: 'date', name: 'consumed_at', required: false },
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE INDEX idx_phone_challenges_phone_created ON participant_phone_challenges (phone_lookup_hash, created)',
      'CREATE INDEX idx_phone_challenges_participant_created ON participant_phone_challenges (participant_id, created)',
      'CREATE INDEX idx_phone_challenges_status_expiry ON participant_phone_challenges (status, expires_at)',
    ],
  });

  return app.save(challenges);
}, (app) => {
  const challenges = app.findCollectionByNameOrId('participant_phone_challenges');
  app.delete(challenges);

  const participants = app.findCollectionByNameOrId('participant_accounts');
  participants.indexes = participants.indexes.filter(
    (index) => index.indexOf('idx_participant_phone_lookup_hash') < 0,
  );
  participants.fields.removeByName('phone_migration_status');
  participants.fields.removeByName('phone_binding_source');
  participants.fields.removeByName('phone_verified_at');
  participants.fields.removeByName('phone_lookup_hash');
  participants.fields.removeByName('phone_e164');
  return app.save(participants);
});
