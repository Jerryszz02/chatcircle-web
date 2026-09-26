import type { PublicPostView } from '../../../public/types';
import { NavAnchor } from '../../../public/nav';
import { formatDateTime } from '../lib/status';

const SUMMARY_LENGTH = 120;

/**
 * 推文封面文件 URL（同源相对路径，绕开 pb SDK：本组件需在服务端渲染图中复用）。
 * 与 PocketBase 文件伺服规则一致：/api/files/{collectionName}/{recordId}/{filename}。
 */
function postCoverUrl(post: Pick<PublicPostView, 'id' | 'cover'>): string {
  if (!post.cover) return '';
  return `/api/files/posts/${encodeURIComponent(post.id)}/${encodeURIComponent(post.cover)}`;
}

function postSummary(post: Pick<PublicPostView, 'summary' | 'body_md'>): string {
  const text = post.summary?.trim() || post.body_md?.trim() || '';
  const normalized = text.replace(/\s+/g, ' ');
  return normalized.length > SUMMARY_LENGTH
    ? `${normalized.slice(0, SUMMARY_LENGTH)}…`
    : normalized;
}

/**
 * 公开推文卡片（SSR 安全纯组件）：首页“往期活动”和完整往期页共用。
 * 阅读全文入口不依赖 body_md 判空：列表数据经服务端 fields 收窄后不含正文，
 * 而后端要求 body_md 与 external_url 至少填一个——无外链即有站内正文可链。
 */
export function PublicPostCard({ post }: { post: PublicPostView }) {
  const coverUrl = postCoverUrl(post);
  const summary = postSummary(post);
  const externalUrl = post.external_url?.trim();

  return (
    <li className="ccp-card">
      {coverUrl ? (
        <img className="ccp-post-cover" src={coverUrl} alt={`${post.title}封面`} />
      ) : null}
      <div className="ccp-card-body">
        <h3 className="ccp-card-title">{post.title}</h3>
        {summary ? <p className="cc-item-meta">{summary}</p> : null}
        {post.published_at ? (
          <p className="cc-item-meta">发布于 {formatDateTime(post.published_at)}</p>
        ) : null}
        {externalUrl ? (
          <a
            href={externalUrl}
            target="_blank"
            rel="noreferrer"
            className="cc-btn cc-btn-secondary cc-btn-block"
          >
            阅读全文
          </a>
        ) : (
          <NavAnchor href={`/posts/${post.id}`} className="cc-btn cc-btn-secondary cc-btn-block">
            阅读全文
          </NavAnchor>
        )}
      </div>
    </li>
  );
}
