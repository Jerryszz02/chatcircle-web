import { COLLECTION_NAMES } from '../../../shared/api/collections';
import type { PostRecord } from '../../../shared/api/types';
import { pbForRole } from '../../../shared/pocketbase';

/**
 * 内容推文表单校验与封面 URL 构造（2026-08 后端改版，database-design §5.2.24）。
 * 校验口径与 pb_hooks/posts.pb.js 服务端一致，前端先行提示、服务端兜底。
 */

/** 公开列表排序约定：置顶优先，再按发布时间倒序（与公开端一致）。 */
export const POSTS_SORT = '-is_pinned,-published_at';

export interface PostFormValues {
  title: string;
  bodyMd: string;
  externalUrl: string;
}

export interface PostFormErrors {
  title?: string;
  /** 正文与外链「至少填一个」的合并错误（两字段共用，展示在正文字段下）。 */
  content?: string;
  externalUrl?: string;
}

const EXTERNAL_URL_PATTERN = /^https?:\/\//i;

/** 表单校验：title 必填；body_md 与 external_url 至少填一个；外链非空时仅允许 http/https。 */
export function validatePostForm(values: PostFormValues): PostFormErrors {
  const errors: PostFormErrors = {};
  if (!values.title.trim()) errors.title = '请填写标题';
  const body = values.bodyMd.trim();
  const url = values.externalUrl.trim();
  if (body === '' && url === '') {
    errors.content = '正文与外链至少填写一项';
  } else if (url !== '' && !EXTERNAL_URL_PATTERN.test(url)) {
    errors.externalUrl = '外链仅允许 http/https 协议';
  }
  return errors;
}

export function hasPostFormErrors(errors: PostFormErrors): boolean {
  return Boolean(errors.title || errors.content || errors.externalUrl);
}

/** 封面图 URL（PocketBase file 字段；无封面返回空串）。超管会话下文件随 viewRule 放行。 */
export function postCoverUrl(post: Pick<PostRecord, 'id' | 'cover'>): string {
  if (!post.cover) return '';
  return pbForRole('super').files.getUrl(
    { id: post.id, collectionName: COLLECTION_NAMES.posts },
    post.cover,
  );
}
