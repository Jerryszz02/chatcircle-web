/// <reference path="../pb_data/types.d.ts" />

// 将参与者端原先写死的两条测试回顾迁移为正式推文。
// - 固定 id 便于迁移验证和回滚；
// - 标题、摘要沿用旧卡片内容；正文暂沿用摘要，后续可在超管后台继续编辑；
// - 直接设为 visible，使部署完成后首页与往期活动页立即恢复展示。

const REVIEW_POSTS = [
  {
    id: 'postreview00001',
    title: '首场活动回顾｜当 13 位青年遇见 15 位倾听者',
    summary:
      '正念开场、一杯饮品、60 分钟一对一对话——回顾 2026 年 6 月 12 日的首场 Chat Circles，看看那个下午发生了什么。',
    publishedAt: '2026-06-12 08:30:00.000Z',
  },
  {
    id: 'postreview00002',
    title: '倾听者手记｜不给建议，也是一种温柔',
    summary:
      '「我学到的最重要的事：把建议咽回去，把耳朵递过去。」一位企业员工倾听者的第一次服务记录。',
    publishedAt: '2026-06-12 08:29:00.000Z',
  },
];

migrate((app) => {
  const collection = app.findCollectionByNameOrId('posts');

  for (const post of REVIEW_POSTS) {
    const record = new Record(collection, {
      id: post.id,
      title: post.title,
      summary: post.summary,
      body_md: post.summary,
      external_url: '',
      is_pinned: false,
      status: 'visible',
      published_at: post.publishedAt,
      // app.save 会触发 posts 审计 hook；数据迁移没有登录态，用固定系统标识归因。
      created_by: 'systemmigration',
      updated_by: 'systemmigration',
    });
    app.save(record);
  }
}, (app) => {
  for (const post of REVIEW_POSTS) {
    const record = app.findRecordById('posts', post.id);
    app.delete(record);
  }
});
