import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { PostRecord } from '../../../shared/api/types';
import { pbClients } from '../../../shared/pocketbase';
import type { PublicLoadError } from '../../../public/types';
import { AccountActions } from '../components/AccountActions';
import { PostPageView } from './PostPageView';

/**
 * 公开推文全文容器（/posts/:postId，未登录可看）：hook 取数后渲染 PostPageView。
 * 数据直读 posts 集合（匿名可读，服务端 rule 只放行 visible）。
 */
export function PostPage() {
  const { postId = '' } = useParams();
  const [post, setPost] = useState<PostRecord | null>(null);
  const [error, setError] = useState<PublicLoadError | null>(null);
  useEffect(() => {
    let stopped = false;
    setPost(null);
    setError(null);
    pbClients.participant
      .collection('posts')
      .getOne<PostRecord>(postId)
      .then((value) => {
        if (!stopped) setPost(value);
      })
      .catch(() => {
        // 404/隐藏/网络错误同一口径：不区分原因，不泄露可见性细节
        if (!stopped) setError({ status: 0, message: '' });
      });
    return () => {
      stopped = true;
    };
  }, [postId]);
  return <PostPageView post={post} error={error} actions={<AccountActions />} />;
}
