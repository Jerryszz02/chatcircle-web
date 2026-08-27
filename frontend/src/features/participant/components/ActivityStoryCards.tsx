/** 活动故事/回顾占位：url 为公众号文章外链，空串表示暂未上线。 */
const ACTIVITY_STORIES: { title: string; excerpt: string; url: string }[] = [
  {
    title: '首场活动回顾｜当 13 位青年遇见 15 位倾听者',
    excerpt:
      '正念开场、一杯饮品、60 分钟一对一对话——回顾 2026 年 6 月 12 日的首场 Chat Circles，看看那个下午发生了什么。',
    url: '',
  },
  {
    title: '倾听者手记｜不给建议，也是一种温柔',
    excerpt:
      '「我学到的最重要的事：把建议咽回去，把耳朵递过去。」一位企业员工倾听者的第一次服务记录。',
    url: '',
  },
];

/** 首页与独立往期活动页共用的活动故事卡片。 */
export function ActivityStoryCards() {
  return (
    <ul className="ccp-card-grid">
      {ACTIVITY_STORIES.map((story) => (
        <li key={story.title} className="ccp-card">
          {/* 文章配图占位：待真实图片素材替换 */}
          <div className="ccp-photo ccp-photo-card" aria-hidden="true">
            文章配图
          </div>
          <div className="ccp-card-body">
            <h3 className="ccp-card-title">{story.title}</h3>
            <p className="cc-item-meta">{story.excerpt}</p>
            {story.url ? (
              <a
                href={story.url}
                target="_blank"
                rel="noreferrer"
                className="cc-btn cc-btn-secondary cc-btn-block"
              >
                阅读原文（公众号）
              </a>
            ) : (
              <p className="cc-item-meta">全文即将上线，敬请期待。</p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
