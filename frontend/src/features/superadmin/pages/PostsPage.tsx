import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { collectionsForRole } from '../../../shared/api/collections';
import { normalizeApiError } from '../../../shared/api/http';
import type { PostRecord, PostStatus } from '../../../shared/api/types';
import { Button, Card, Input, Loading, Modal } from '../../../shared/ui';
import { SuperLayout } from '../SuperLayout';
import { useSuperToast } from '../hooks';
import { formatDateTime } from '../lib/format';
import { POST_STATUS_LABELS } from '../lib/labels';
import {
  POSTS_SORT,
  hasPostFormErrors,
  postCoverUrl,
  validatePostForm,
  type PostFormErrors,
} from '../lib/posts';

/**
 * 内容推文管理（/super/posts，2026-08 后端改版，database-design §5.2.24）。
 * - 列表/新建/编辑/置顶/显隐；无删除按钮（deleteRule 关闭，隐藏即删除）；
 * - 封面为 file 单图：表单整体走 FormData 提交，既有封面经 files.getUrl 展示；
 * - published_at 由服务端在首次置 visible 时写入，前端只读展示；
 * - created_by/updated_by 由服务端强制填充，前端不传。
 */
export function SuperPostsPage() {
  const { toast } = useSuperToast();
  const cc = useMemo(() => collectionsForRole('super'), []);

  const [posts, setPosts] = useState<PostRecord[] | null>(null);
  const [saving, setSaving] = useState(false);

  // 编辑器弹窗：editing 为 null 表示新建
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PostRecord | null>(null);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [bodyMd, setBodyMd] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [isPinned, setIsPinned] = useState(false);
  const [status, setStatus] = useState<PostStatus>('hidden');
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverObjectUrl, setCoverObjectUrl] = useState<string | null>(null);
  /** 显式移除既有封面（独立于 coverFile：null 表示保留原图，须单独标记才能清空）。 */
  const [removeCover, setRemoveCover] = useState(false);
  const [formErrors, setFormErrors] = useState<PostFormErrors>({});

  const loadPosts = useCallback(async () => {
    setPosts(await cc.posts.getFullList({ sort: POSTS_SORT }));
  }, [cc]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await cc.posts.getFullList({ sort: POSTS_SORT });
        if (!cancelled) setPosts(list);
      } catch (err) {
        if (!cancelled) toast(normalizeApiError(err).message, 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cc, toast]);

  // 新选封面的本地预览 object URL（更换/卸载时回收）
  useEffect(() => {
    if (!coverFile) {
      setCoverObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(coverFile);
    setCoverObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [coverFile]);

  const openCreate = () => {
    setEditing(null);
    setTitle('');
    setSummary('');
    setBodyMd('');
    setExternalUrl('');
    setIsPinned(false);
    setStatus('hidden');
    setCoverFile(null);
    setRemoveCover(false);
    setFormErrors({});
    setEditorOpen(true);
  };

  const openEdit = (post: PostRecord) => {
    setEditing(post);
    setTitle(post.title);
    setSummary(post.summary ?? '');
    setBodyMd(post.body_md ?? '');
    setExternalUrl(post.external_url ?? '');
    setIsPinned(post.is_pinned);
    setStatus(post.status);
    setCoverFile(null);
    setRemoveCover(false);
    setFormErrors({});
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditing(null);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const errors = validatePostForm({ title, bodyMd, externalUrl });
    setFormErrors(errors);
    if (hasPostFormErrors(errors)) return;
    setSaving(true);
    // 封面为 file 字段，整体走 FormData；cover 键三态：
    // 选了新文件 → 上传替换；显式点「移除封面」→ 空字符串删除原图（已实测后端行为）；
    // 两者皆无 → 不带 cover 键，保留原图
    const data = new FormData();
    data.set('title', title.trim());
    data.set('summary', summary.trim());
    data.set('body_md', bodyMd.trim());
    data.set('external_url', externalUrl.trim());
    data.set('is_pinned', String(isPinned));
    data.set('status', status);
    if (coverFile) {
      data.set('cover', coverFile);
    } else if (removeCover && editing?.cover) {
      data.set('cover', '');
    }
    try {
      if (editing) {
        await cc.posts.update(editing.id, data);
        toast('推文已更新', 'success');
      } else {
        await cc.posts.create(data);
        toast(
          status === 'visible' ? '推文已创建并公开' : '推文已创建（当前为隐藏状态）',
          'success',
        );
      }
      closeEditor();
      await loadPosts();
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const onTogglePin = async (post: PostRecord) => {
    setSaving(true);
    try {
      await cc.posts.update(post.id, { is_pinned: !post.is_pinned });
      toast(post.is_pinned ? '已取消置顶' : '已置顶', 'success');
      await loadPosts();
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const onToggleStatus = async (post: PostRecord) => {
    const next: PostStatus = post.status === 'visible' ? 'hidden' : 'visible';
    setSaving(true);
    try {
      await cc.posts.update(post.id, { status: next });
      toast(next === 'visible' ? '推文已设为可见' : '推文已隐藏', 'success');
      await loadPosts();
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const coverPreview =
    coverObjectUrl ?? (editing?.cover && !removeCover ? postCoverUrl(editing) : null);

  return (
    <SuperLayout title="内容推文">
      <Card title="推文列表" actions={<Button onClick={openCreate}>新建推文</Button>}>
        {posts === null ? (
          <Loading />
        ) : posts.length === 0 ? (
          <p className="sa-muted">暂无推文，请先新建。</p>
        ) : (
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>封面</th>
                  <th>标题</th>
                  <th>状态</th>
                  <th>置顶</th>
                  <th>发布时间</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((post) => (
                  <tr key={post.id}>
                    <td>
                      {post.cover ? (
                        <img
                          className="sa-post-cover"
                          src={postCoverUrl(post)}
                          alt={`${post.title}封面`}
                        />
                      ) : (
                        <span className="sa-muted">—</span>
                      )}
                    </td>
                    <td className="sa-cell-wrap">{post.title}</td>
                    <td>
                      <span
                        className={`sa-badge${post.status === 'visible' ? ' sa-badge-success' : ''}`}
                      >
                        {POST_STATUS_LABELS[post.status]}
                      </span>
                    </td>
                    <td>
                      {post.is_pinned ? (
                        <span className="sa-badge sa-badge-info">已置顶</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{formatDateTime(post.published_at)}</td>
                    <td>{formatDateTime(post.updated)}</td>
                    <td>
                      <div className="sa-actions">
                        <Button variant="secondary" onClick={() => openEdit(post)}>
                          编辑
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={saving}
                          onClick={() => void onTogglePin(post)}
                        >
                          {post.is_pinned ? '取消置顶' : '置顶'}
                        </Button>
                        <Button
                          variant={post.status === 'visible' ? 'danger' : 'secondary'}
                          disabled={saving}
                          onClick={() => void onToggleStatus(post)}
                        >
                          {post.status === 'visible' ? '隐藏' : '设为可见'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="sa-muted">
          推文不提供删除：隐藏后即从公开端消失（无硬删除，隐藏即删除）；创建与更新均写入审计日志。
        </p>
      </Card>

      <Modal
        open={editorOpen}
        title={editing ? '编辑推文' : '新建推文'}
        onClose={closeEditor}
        footer={
          <>
            <Button type="submit" form="sa-post-form" loading={saving}>
              {editing ? '保存' : '创建'}
            </Button>
            <Button variant="secondary" onClick={closeEditor}>
              取消
            </Button>
          </>
        }
      >
        <form id="sa-post-form" onSubmit={(e) => void onSubmit(e)} noValidate>
          <Input
            label="标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            error={formErrors.title}
            required
          />
          <Input
            label="摘要"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            hint="选填；为空时公开端摘取正文前若干字兜底"
          />
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-post-cover">
              封面图
            </label>
            <input
              id="sa-post-cover"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                setCoverFile(file);
                // 重选新文件即放弃「移除封面」标记
                if (file) setRemoveCover(false);
              }}
            />
            <p className="cc-hint">选填，单图，不超过 5MB（image/jpeg、png、webp、gif）</p>
            {coverPreview ? (
              <img className="sa-post-cover-preview" src={coverPreview} alt="封面预览" />
            ) : null}
            {editing?.cover && !coverFile ? (
              <div className="sa-post-cover-actions">
                {removeCover ? (
                  <>
                    <span className="sa-muted">封面将在保存后移除</span>
                    <Button variant="secondary" onClick={() => setRemoveCover(false)}>
                      撤销
                    </Button>
                  </>
                ) : (
                  <Button variant="secondary" onClick={() => setRemoveCover(true)}>
                    移除封面
                  </Button>
                )}
              </div>
            ) : null}
          </div>
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-post-body">
              正文（Markdown）
            </label>
            <textarea
              id="sa-post-body"
              className="sa-textarea"
              value={bodyMd}
              onChange={(e) => setBodyMd(e.target.value)}
            />
            {formErrors.content ? (
              <p className="cc-error" role="alert">
                {formErrors.content}
              </p>
            ) : null}
          </div>
          <Input
            label="外链 URL"
            value={externalUrl}
            onChange={(e) => setExternalUrl(e.target.value)}
            error={formErrors.externalUrl}
            hint="选填，仅允许 http/https；正文与外链至少填写一项"
            placeholder="https://…"
          />
          <div className="cc-field">
            <label className="cc-label">
              <input
                type="checkbox"
                checked={isPinned}
                onChange={(e) => setIsPinned(e.target.checked)}
              />{' '}
              置顶（公开列表优先展示）
            </label>
          </div>
          <div className="cc-field">
            <label className="cc-label" htmlFor="sa-post-status">
              可见性
            </label>
            <select
              id="sa-post-status"
              className="sa-select"
              value={status}
              onChange={(e) => setStatus(e.target.value as PostStatus)}
            >
              <option value="hidden">隐藏（仅后台可见）</option>
              <option value="visible">可见（公开端展示）</option>
            </select>
          </div>
          <p className="sa-muted">
            发布时间由服务端在首次设为可见时自动写入，之后不因隐藏/再可见而改。
          </p>
        </form>
      </Modal>
    </SuperLayout>
  );
}
