/// <reference path="../pb_data/types.d.ts" />

// 迁移 22：cc_rate_counters — 数据库化的原子限流计数
// 背景：安全审查 finding 2/7（CWE-362）。原实现用 $app.store() 做「先 get 检查、业务后再 set 写回」
// 的非原子计数，并发请求可同时读到旧计数并相互覆盖，从而绕过登录/短信/邮件阈值。
// store() 无原子自增原语，无法在 JSVM 内做「检查即预占」；改用 DB 记录 + $app.runInTransaction
// 实现原子性：事务内读→过滤→判定→写入，写冲突由 SQLite 忙等重试收敛（同 checkins/trainings 既有做法）。
//
// 数据形态：每限流键一行，key 文本唯一索引；slots 为 json 数组（滑动窗口内的失败/尝试时间戳，
// epoch 秒）。窗口语义与原实现一致：只统计 `ts > now - windowSec` 的时间戳，长度 >= max 即拒绝。
// —— 仅作内部计数表，API rules 全 null，无任何对外读写入口。

migrate((app) => {
  const collection = new Collection({
    type: 'base',
    name: 'cc_rate_counters',
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      // 限流键（'用途|…|identifier' 拼接，如 'cc_rl|participant|user|ip'）
      { type: 'text', name: 'key', required: true, max: 255 },
      // 滑动窗口内的时间戳数组（epoch 秒），json 字段在 JSVM 内以原始 JS 数组回读
      { type: 'json', name: 'slots', required: false },
      // 系统时间字段（PocketBase 0.28 不再自动附加，需显式声明）
      { type: 'autodate', name: 'created', onCreate: true, onUpdate: false },
      { type: 'autodate', name: 'updated', onCreate: true, onUpdate: true },
    ],
    indexes: ['CREATE UNIQUE INDEX idx_cc_rate_counters_key ON cc_rate_counters (key)'],
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId('cc_rate_counters');
  return app.delete(collection);
});
