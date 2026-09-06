import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Markdown from 'react-markdown';
import type { PostRecord } from '../../../shared/api/types';
import { pbClients } from '../../../shared/pocketbase';
import { Loading } from '../../../shared/ui';
import { PublicPageLayout } from '../components/PublicPageLayout';
import { formatDateTime } from '../lib/status';

export function PostPage() {
  const { postId = '' } = useParams();
  const [post, setPost] = useState<PostRecord | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let stopped = false;
    setPost(null);
    setError(false);
    pbClients.participant
      .collection('posts')
      .getOne<PostRecord>(postId)
      .then((value) => {
        if (!stopped) setPost(value);
      })
      .catch(() => {
        if (!stopped) setError(true);
      });
    return () => {
      stopped = true;
    };
  }, [postId]);
  return (
    <PublicPageLayout>
      <article className="ccp-reading">
        <Link to="/activities/past">返回往期活动</Link>
        {error ? (
          <p role="alert">文章不存在、已隐藏或暂时无法读取，请返回列表重试。</p>
        ) : !post ? (
          <Loading />
        ) : (
          <>
            <h1>{post.title}</h1>
            <p className="cc-item-meta">发布于 {formatDateTime(post.published_at)}</p>
            <Markdown skipHtml components={{ img: ({ alt }) => <span>{alt}</span> }}>
              {post.body_md || post.summary || ''}
            </Markdown>
            {post.external_url ? (
              <a href={post.external_url} target="_blank" rel="noreferrer">
                阅读原文
              </a>
            ) : null}
          </>
        )}
      </article>
    </PublicPageLayout>
  );
}
