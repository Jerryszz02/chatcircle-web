/// <reference path="../pb_data/types.d.ts" />

// T2：现场编号与活动配对
// 契约：docs/planning/api-design.md §4、database-design.md §6.3/§6.4。
// - activities 保存配对开始/现场锁定事实与两个角色的单调递增编号计数器；
// - checkins 保存签到时的角色快照与不可复用现场序号；
// - activity_pairs 只允许 hooks 写入，参与者不能直读或订阅记录；
// - 存量签到不补号，存量活动计数器从 1 开始。

migrate((app) => {
  const activities = app.findCollectionByNameOrId('activities');

  activities.fields.add(new Field({
    type: 'date', name: 'pairing_started_at', required: false,
  }));
  activities.fields.add(new Field({
    type: 'text', name: 'pairing_started_by', required: false,
  }));
  activities.fields.add(new Field({
    type: 'date', name: 'onsite_locked_at', required: false,
  }));
  activities.fields.add(new Field({
    type: 'text', name: 'onsite_locked_by', required: false,
  }));
  // 先以 optional 加入并回填，随后收紧 required，兼容已有活动记录。
  activities.fields.add(new Field({
    type: 'number', name: 'next_speaker_sequence', required: false, onlyInt: true, min: 1,
  }));
  activities.fields.add(new Field({
    type: 'number', name: 'next_listener_sequence', required: false, onlyInt: true, min: 1,
  }));
  app.save(activities);

  const existingActivities = app.findRecordsByFilter('activities', '', '', 5000, 0);
  for (const activity of existingActivities) {
    activity.set('next_speaker_sequence', 1);
    activity.set('next_listener_sequence', 1);
    app.save(activity);
  }
  activities.fields.getByName('next_speaker_sequence').required = true;
  activities.fields.getByName('next_listener_sequence').required = true;
  app.save(activities);

  const checkins = app.findCollectionByNameOrId('checkins');
  checkins.fields.add(new Field({
    type: 'select', name: 'onsite_role', required: false, maxSelect: 1,
    values: ['speaker', 'listener'],
  }));
  checkins.fields.add(new Field({
    type: 'number', name: 'onsite_sequence', required: false, onlyInt: true, min: 1,
  }));
  checkins.fields.add(new Field({
    type: 'date', name: 'numbered_at', required: false,
  }));
  checkins.indexes.push(
    'CREATE UNIQUE INDEX idx_checkins_activity_onsite_sequence ON checkins (activity_id, onsite_role, onsite_sequence) WHERE onsite_sequence > 0',
  );
  app.save(checkins);

  const registrations = app.findCollectionByNameOrId('registrations');
  const pairs = new Collection({
    type: 'base',
    name: 'activity_pairs',
    listRule: '@request.auth.organization_id = activity_id.organization_id',
    viewRule: '@request.auth.organization_id = activity_id.organization_id',
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        type: 'relation', name: 'activity_id', required: true,
        collectionId: activities.id, cascadeDelete: false, maxSelect: 1,
      },
      { type: 'number', name: 'pair_sequence', required: true, onlyInt: true, min: 1 },
      {
        type: 'relation', name: 'speaker_registration_id', required: true,
        collectionId: registrations.id, cascadeDelete: false, maxSelect: 1,
      },
      {
        type: 'relation', name: 'listener_registration_id', required: true,
        collectionId: registrations.id, cascadeDelete: false, maxSelect: 1,
      },
      {
        type: 'relation', name: 'speaker_checkin_id', required: true,
        collectionId: checkins.id, cascadeDelete: false, maxSelect: 1,
      },
      {
        type: 'relation', name: 'listener_checkin_id', required: true,
        collectionId: checkins.id, cascadeDelete: false, maxSelect: 1,
      },
      {
        type: 'select', name: 'status', required: true, maxSelect: 1,
        values: ['active', 'released', 'completed'],
      },
      { type: 'date', name: 'paired_at', required: true },
      { type: 'text', name: 'paired_by', required: true },
      { type: 'text', name: 'adjustment_reason', required: false },
      { type: 'date', name: 'released_at', required: false },
      { type: 'text', name: 'released_by', required: false },
      { type: 'text', name: 'release_reason', required: false },
      { type: 'date', name: 'completed_at', required: false },
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_activity_pairs_activity_sequence ON activity_pairs (activity_id, pair_sequence)',
      'CREATE INDEX idx_activity_pairs_activity_status ON activity_pairs (activity_id, status)',
      'CREATE INDEX idx_activity_pairs_speaker_checkin_status ON activity_pairs (speaker_checkin_id, status)',
      'CREATE INDEX idx_activity_pairs_listener_checkin_status ON activity_pairs (listener_checkin_id, status)',
    ],
  });

  return app.save(pairs);
}, (app) => {
  const pairs = app.findCollectionByNameOrId('activity_pairs');
  app.delete(pairs);

  const checkins = app.findCollectionByNameOrId('checkins');
  checkins.fields.removeByName('onsite_role');
  checkins.fields.removeByName('onsite_sequence');
  checkins.fields.removeByName('numbered_at');
  checkins.indexes = checkins.indexes.filter(
    (index) => index.indexOf('idx_checkins_activity_onsite_sequence') === -1,
  );
  app.save(checkins);

  const activities = app.findCollectionByNameOrId('activities');
  for (const field of [
    'pairing_started_at', 'pairing_started_by', 'onsite_locked_at', 'onsite_locked_by',
    'next_speaker_sequence', 'next_listener_sequence',
  ]) {
    activities.fields.removeByName(field);
  }
  return app.save(activities);
});
