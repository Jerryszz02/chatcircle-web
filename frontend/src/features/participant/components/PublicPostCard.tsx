import type { PostRecord } from '../../../shared/api/types';
import { COLLECTION_NAMES } from '../../../shared/api/collections';
import { pbClients } from '../../../shared/pocketbase';
import { formatDateTime } from '../lib/status';

const SUMMARY_LENGTH = 120;

function postCoverUrl(post: Pick<PostRecord, 'id' | 'cover'>): string {
  if (!post.cover) return '';
  return pbClients.participant.files.getUrl(
    { id: post.id, collectionName: COLLECTION_NAMES.posts },
    post.cover,
  );
}

function postSummary(post: Pick<PostRecord, 'summary' | 'body_md'>): string {
  const text = post.summary?.trim() || post.body_md?.trim() || '';
  const normalized = text.replace(/\s+/g, ' ');
  return normalized.length > SUMMARY_LENGTH
    ? `${normalized.slice(0, SUMMARY_LENGTH)}…`
    : normalized;
}

/** 公开推文卡片：首页“往期活动”和完整往期页共用。 */
export function PublicPostCard({ post }: { post: PostRecord }) {
  const coverUrl = postCoverUrl(post);
  const summary = postSummary(post);

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
        {post.external_url ? (
          <a
            href={post.external_url}
            target="_blank"
            rel="noreferrer"
            className="cc-btn cc-btn-secondary cc-btn-block"
          >
            阅读原文
          </a>
        ) : null}
      </div>
    </li>
  );
}
