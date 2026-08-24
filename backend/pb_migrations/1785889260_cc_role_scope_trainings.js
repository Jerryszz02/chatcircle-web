/// <reference path="../pb_data/types.d.ts" />

// 迁移 22：分角色报名字段（registration_field_defs.role_scope）+ 聆听者培训体系三集合
// （trainings / training_checkin_sessions / training_attendances）
//
// role_scope：字段级角色标记（both/speaker/listener），报名校验只对该角色适用字段生效。
// - PocketBase select 无 schema 级默认值，故 required=false + 本迁移把存量行回填为 'both'
//   （存量行为不变），hooks 读取侧对空值按 'both' 归一（防御性双保险）。
//
// trainings —— 培训主数据（与活动解绑，database-design 培训体系）：
// - 状态机 3 态：draft / published / closed（hooks 端点流转，直连守卫强制创建为 draft）；
// - training_code 可读稳定代码（唯一）；checkin_qr_token 固定签到二维码 token，
//   required=false + 唯一索引，由 trainings.pb.js onRecordCreate 生成 24 位随机 token
//   （服务端唯一生成方，同迁移 20 activities 加固做法）；
// - API Rules 镜像 activities（迁移 20 收紧后形态）：机构管理员按机构隔离读写，
//   超管放行；参与者/匿名不可直读（培训信息经 /api/cc/me/trainings 白名单端点下发）；
//   deleteRule 关闭（无硬删除，FR-AUD-001）。
//
// training_checkin_sessions —— 培训签到开放窗口（镜像 checkin_sessions，迁移 10）：
// - 「未开放」不建行；同一培训同一时间至多一条 open 记录由 hooks 事务保证；
// - 直连写由 guards.pb.js 全锁（开放/关闭走 /api/cc/trainings/{id}/checkin/open|close）。
//
// training_attendances —— 培训签到记录（镜像 checkins，迁移 11）：
// - 每人每培训至多一条 valid：SQLite 无法表达部分唯一，由 hooks 事务查重保证，
//   故不建 (training_id, participant_id) 全量唯一索引（否则撤销后无法重签）；
// - 「已撤销」保留原记录（status=revoked）；「培训通过」账号级口径 = 存在任一 valid 记录；
// - 直连写全锁（create/update 只走 hooks 端点），deleteRule 关闭。

migrate((app) => {
  // --- 1. registration_field_defs 增加 role_scope（存量回填 both） -----------------
  const fieldDefs = app.findCollectionByNameOrId('registration_field_defs');
  fieldDefs.fields.add(new Field({
    type: 'select',
    name: 'role_scope',
    required: false,
    maxSelect: 1,
    values: ['both', 'speaker', 'listener'],
  }));
  app.save(fieldDefs);
  const defs = app.findRecordsByFilter('registration_field_defs', "role_scope = ''", '', 5000, 0);
  for (const def of defs) {
    def.set('role_scope', 'both');
    app.save(def);
  }

  // --- 2. trainings ---------------------------------------------------------------
  const organizations = app.findCollectionByNameOrId('organizations');
  const trainings = new Collection({
    type: 'base',
    name: 'trainings',
    listRule: '@request.auth.organization_id = organization_id',
    viewRule: '@request.auth.organization_id = organization_id',
    createRule: '@request.auth.organization_id = organization_id',
    updateRule: '@request.auth.organization_id = organization_id',
    deleteRule: null,
    fields: [
      // 机构隔离主键
      {
        type: 'relation',
        name: 'organization_id',
        required: true,
        collectionId: organizations.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      { type: 'text', name: 'title', required: true },
      // 可读稳定代码，建议机构缩写+日期+序号（同 activities.activity_code 约定）
      { type: 'text', name: 'training_code', required: true },
      { type: 'text', name: 'description', required: false },
      { type: 'text', name: 'location', required: false },
      { type: 'date', name: 'start_time', required: false },
      { type: 'date', name: 'end_time', required: false },
      // draft / published / closed：状态流转只走 /api/cc/trainings/{id}/publish|close 端点
      {
        type: 'select',
        name: 'status',
        required: true,
        maxSelect: 1,
        values: ['draft', 'published', 'closed'],
      },
      // 固定签到二维码 token：服务端 onRecordCreate 生成（客户端不可指定/变更）
      { type: 'text', name: 'checkin_qr_token', required: false },
      // 系统时间字段：PocketBase 0.28 不再自动附加 created/updated，需显式声明（database-design §5.1）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_trainings_training_code ON trainings (training_code)',
      'CREATE UNIQUE INDEX idx_trainings_checkin_qr_token ON trainings (checkin_qr_token)',
      'CREATE INDEX idx_trainings_org_status ON trainings (organization_id, status)',
      'CREATE INDEX idx_trainings_status ON trainings (status)',
    ],
  });
  app.save(trainings);

  // --- 3. training_checkin_sessions ------------------------------------------------
  const sessions = new Collection({
    type: 'base',
    name: 'training_checkin_sessions',
    listRule: '@request.auth.organization_id = training_id.organization_id',
    viewRule: '@request.auth.organization_id = training_id.organization_id',
    createRule: '@request.auth.organization_id = training_id.organization_id',
    updateRule: '@request.auth.organization_id = training_id.organization_id',
    deleteRule: null,
    fields: [
      {
        type: 'relation',
        name: 'training_id',
        required: true,
        collectionId: trainings.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      // open=已开放 / closed=已关闭
      { type: 'select', name: 'status', required: true, maxSelect: 1, values: ['open', 'closed'] },
      { type: 'date', name: 'opened_at', required: true },
      { type: 'date', name: 'closed_at', required: false },
      { type: 'text', name: 'opened_by', required: true }, // 操作管理员 id
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE INDEX idx_training_checkin_sessions_training_status ON training_checkin_sessions (training_id, status)',
    ],
  });
  app.save(sessions);

  // --- 4. training_attendances ------------------------------------------------------
  const participantAccounts = app.findCollectionByNameOrId('participant_accounts');
  const attendances = new Collection({
    type: 'base',
    name: 'training_attendances',
    // 管理员按机构隔离只读；参与者只读本人记录；直连写全锁（走 hooks 端点）
    listRule: '@request.auth.organization_id = training_id.organization_id || @request.auth.id = participant_id',
    viewRule: '@request.auth.organization_id = training_id.organization_id || @request.auth.id = participant_id',
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        type: 'relation',
        name: 'training_id',
        required: true,
        collectionId: trainings.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      {
        type: 'relation',
        name: 'participant_id',
        required: true,
        collectionId: participantAccounts.id,
        cascadeDelete: false,
        maxSelect: 1,
      },
      // self_scan=自助扫码 / manual=管理员补签
      { type: 'select', name: 'source', required: true, maxSelect: 1, values: ['self_scan', 'manual'] },
      // valid=已签到（培训通过） / revoked=已撤销
      { type: 'select', name: 'status', required: true, maxSelect: 1, values: ['valid', 'revoked'] },
      { type: 'date', name: 'checked_in_at', required: true },
      { type: 'text', name: 'operator_id', required: false }, // 补签/撤销操作管理员 id；自助签到为空
      { type: 'text', name: 'reason', required: false }, // 补签/撤销必填原因，由 hooks 校验
      { type: 'date', name: 'revoked_at', required: false },
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE INDEX idx_training_attendances_training_participant_status ON training_attendances (training_id, participant_id, status)',
      'CREATE INDEX idx_training_attendances_participant ON training_attendances (participant_id)',
      'CREATE INDEX idx_training_attendances_status ON training_attendances (status)',
    ],
  });
  return app.save(attendances);
}, (app) => {
  // 先删子集合（relation 引用方），再删 trainings，最后撤 role_scope
  for (const name of ['training_attendances', 'training_checkin_sessions', 'trainings']) {
    const collection = app.findCollectionByNameOrId(name);
    app.delete(collection);
  }
  const fieldDefs = app.findCollectionByNameOrId('registration_field_defs');
  fieldDefs.fields.removeByName('role_scope');
  return app.save(fieldDefs);
});
