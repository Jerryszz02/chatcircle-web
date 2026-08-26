import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PostRecord } from '../../../shared/api/types';
import { clearAllSessions, stubApi, unstubApi, type ApiMock } from '../../../test/mockApi';
import { SuperPostsPage } from './PostsPage';

/**
 * 内容推文管理页（/super/posts）测试：
 * 列表渲染（含排序约定与封面展示）、新建/编辑表单校验与提交（FormData）、
 * 显隐/置顶切换调用。无删除入口（隐藏即删除，database-design §5.2.24）。
 */

function makePost(overrides: Partial<PostRecord> = {}): PostRecord {
  return {
    id: 'post1',
    created: '2026-08-01 00:00:00.000Z',
    updated: '2026-08-11 02:00:00.000Z',
    title: '示例推文',
    summary: '',
    cover: '',
    body_md: '# 正文',
    external_url: '',
    is_pinned: false,
    status: 'hidden',
    published_at: '',
    ...overrides,
  };
}

function listBody(items: PostRecord[]) {
  return { body: { page: 1, perPage: 100, totalItems: items.length, totalPages: 1, items } };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/super/posts']}>
      <SuperPostsPage />
    </MemoryRouter>,
  );
}

function callsOf(mock: ApiMock, method: string) {
  return mock.calls.filter((c) => (c.init?.method ?? 'GET').toUpperCase() === method);
}

function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest('tr');
  if (!row) throw new Error(`找不到含「${text}」的表格行`);
  return row;
}

describe('SuperPostsPage 内容推文管理', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('列表渲染：标题/状态/置顶/时间列，按「置顶优先+发布时间倒序」约定请求', async () => {
    const mock = stubApi({
      'GET /api/collections/posts/records': listBody([
        makePost({
          id: 'post1',
          title: '置顶推文',
          status: 'visible',
          is_pinned: true,
          published_at: '2026-08-10 02:00:00.000Z',
        }),
        makePost({ id: 'post2', title: '隐藏草稿', status: 'hidden' }),
      ]),
    });
    renderPage();
    expect(await screen.findByText('置顶推文')).toBeInTheDocument();
    expect(screen.getByText('隐藏草稿')).toBeInTheDocument();
    const row1 = rowOf('置顶推文');
    expect(within(row1).getByText('可见')).toBeInTheDocument();
    expect(within(row1).getByText('已置顶')).toBeInTheDocument();
    const row2 = rowOf('隐藏草稿');
    expect(within(row2).getByText('隐藏')).toBeInTheDocument();
    // 无删除入口
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
    // 排序与公开端约定一致（sort 参数经 URL 编码）
    const listCall = mock.calls.find((c) => c.url.includes('/api/collections/posts/records'));
    expect(decodeURIComponent(listCall?.url ?? '')).toContain('sort=-is_pinned,-published_at');
  });

  it('空列表展示空态文案', async () => {
    stubApi({ 'GET /api/collections/posts/records': listBody([]) });
    renderPage();
    expect(await screen.findByText(/暂无推文/)).toBeInTheDocument();
  });

  it('新建表单校验：标题必填、正文与外链至少其一，校验不过不发请求', async () => {
    const mock = stubApi({
      'GET /api/collections/posts/records': listBody([]),
      'POST /api/collections/posts/records': { body: makePost({ id: 'post_new' }) },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '新建推文' }));
    const dialog = screen.getByRole('dialog', { name: '新建推文' });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));
    expect(await screen.findByText('请填写标题')).toBeInTheDocument();
    expect(screen.getByText('正文与外链至少填写一项')).toBeInTheDocument();
    expect(callsOf(mock, 'POST')).toHaveLength(0);

    // 外链协议非法同样拦截
    fireEvent.change(within(dialog).getByLabelText(/标题/), { target: { value: '新推文' } });
    fireEvent.change(within(dialog).getByLabelText('正文（Markdown）'), {
      target: { value: '一些正文' },
    });
    fireEvent.change(within(dialog).getByLabelText('外链 URL'), {
      target: { value: 'javascript:alert(1)' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));
    expect(await screen.findByText('外链仅允许 http/https 协议')).toBeInTheDocument();
    expect(callsOf(mock, 'POST')).toHaveLength(0);
  });

  it('新建成功：清空非法外链后以 FormData 提交（封面 file 字段约定）', async () => {
    const mock = stubApi({
      'GET /api/collections/posts/records': listBody([]),
      'POST /api/collections/posts/records': { body: makePost({ id: 'post_new' }) },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '新建推文' }));
    const dialog = screen.getByRole('dialog', { name: '新建推文' });
    fireEvent.change(within(dialog).getByLabelText(/标题/), { target: { value: '新推文' } });
    fireEvent.change(within(dialog).getByLabelText('正文（Markdown）'), {
      target: { value: '# 一些正文' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /置顶/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));
    await waitFor(() => expect(callsOf(mock, 'POST')).toHaveLength(1));
    const create = callsOf(mock, 'POST')[0];
    expect(create.url).toContain('/api/collections/posts/records');
    const fd = create.init?.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.get('title')).toBe('新推文');
    expect(fd.get('body_md')).toBe('# 一些正文');
    expect(fd.get('status')).toBe('hidden');
    expect(fd.get('is_pinned')).toBe('true');
    // 未选封面时不带 cover 键；归因字段由服务端填充
    expect(fd.get('cover')).toBeNull();
    expect(fd.get('created_by')).toBeNull();
    expect(fd.get('updated_by')).toBeNull();
  });

  it('编辑：弹窗预填原值、既有封面可预览，保存走 PATCH 且不带 cover 键保留原图', async () => {
    const mock = stubApi({
      'GET /api/collections/posts/records': listBody([
        makePost({
          id: 'post9',
          title: '旧标题',
          body_md: '旧正文',
          external_url: 'https://example.com/a',
          cover: 'cover_abc.png',
        }),
      ]),
      'PATCH /api/collections/posts/records': { body: makePost({ id: 'post9' }) },
    });
    renderPage();
    await screen.findByText('旧标题');
    const row = rowOf('旧标题');
    // 既有封面经 files.getUrl 构造 URL 展示
    expect(within(row).getByRole('img', { name: '旧标题封面' })).toHaveAttribute(
      'src',
      expect.stringContaining('/api/files/posts/post9/cover_abc.png'),
    );
    fireEvent.click(within(row).getByRole('button', { name: '编辑' }));
    const dialog = screen.getByRole('dialog', { name: '编辑推文' });
    expect(within(dialog).getByLabelText(/标题/)).toHaveValue('旧标题');
    expect(within(dialog).getByLabelText('正文（Markdown）')).toHaveValue('旧正文');
    expect(within(dialog).getByLabelText('外链 URL')).toHaveValue('https://example.com/a');
    fireEvent.change(within(dialog).getByLabelText(/标题/), { target: { value: '新标题' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(callsOf(mock, 'PATCH')).toHaveLength(1));
    const patch = callsOf(mock, 'PATCH')[0];
    expect(patch.url).toContain('/api/collections/posts/records/post9');
    const fd = patch.init?.body as FormData;
    expect(fd.get('title')).toBe('新标题');
    expect(fd.get('body_md')).toBe('旧正文');
    expect(fd.get('cover')).toBeNull();
  });

  it('显隐切换：visible → hidden、hidden → visible 均走 PATCH', async () => {
    const mock = stubApi({
      'GET /api/collections/posts/records': listBody([
        makePost({ id: 'post1', title: '已公开', status: 'visible' }),
        makePost({ id: 'post2', title: '未公开', status: 'hidden' }),
      ]),
      'PATCH /api/collections/posts/records': { body: makePost() },
    });
    renderPage();
    await screen.findByText('已公开');
    fireEvent.click(within(rowOf('已公开')).getByRole('button', { name: '隐藏' }));
    await waitFor(() => expect(callsOf(mock, 'PATCH')).toHaveLength(1));
    expect(callsOf(mock, 'PATCH')[0].url).toContain('/records/post1');
    expect(callsOf(mock, 'PATCH')[0].init?.body).toBe(JSON.stringify({ status: 'hidden' }));

    fireEvent.click(within(rowOf('未公开')).getByRole('button', { name: '设为可见' }));
    await waitFor(() => expect(callsOf(mock, 'PATCH')).toHaveLength(2));
    expect(callsOf(mock, 'PATCH')[1].url).toContain('/records/post2');
    expect(callsOf(mock, 'PATCH')[1].init?.body).toBe(JSON.stringify({ status: 'visible' }));
  });

  it('编辑有封面推文：点「移除封面」后提交，FormData 带 cover 空字符串', async () => {
    const mock = stubApi({
      'GET /api/collections/posts/records': listBody([
        makePost({ id: 'post9', title: '带封面', cover: 'cover_abc.png' }),
      ]),
      'PATCH /api/collections/posts/records': { body: makePost({ id: 'post9' }) },
    });
    renderPage();
    await screen.findByText('带封面');
    fireEvent.click(within(rowOf('带封面')).getByRole('button', { name: '编辑' }));
    const dialog = screen.getByRole('dialog', { name: '编辑推文' });
    // 初始展示既有封面预览；点击移除后预览消失
    expect(within(dialog).getByRole('img', { name: '封面预览' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '移除封面' }));
    expect(within(dialog).queryByRole('img', { name: '封面预览' })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/封面将在保存后移除/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(callsOf(mock, 'PATCH')).toHaveLength(1));
    const fd = callsOf(mock, 'PATCH')[0].init?.body as FormData;
    // 空字符串 = 删除该文件（已实测后端行为）
    expect(fd.get('cover')).toBe('');
  });

  it('编辑有封面推文：移除后再「撤销」，提交不带 cover 键（保留原图）', async () => {
    const mock = stubApi({
      'GET /api/collections/posts/records': listBody([
        makePost({ id: 'post9', title: '带封面', cover: 'cover_abc.png' }),
      ]),
      'PATCH /api/collections/posts/records': { body: makePost({ id: 'post9' }) },
    });
    renderPage();
    await screen.findByText('带封面');
    fireEvent.click(within(rowOf('带封面')).getByRole('button', { name: '编辑' }));
    const dialog = screen.getByRole('dialog', { name: '编辑推文' });
    fireEvent.click(within(dialog).getByRole('button', { name: '移除封面' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '撤销' }));
    // 撤销后预览恢复
    expect(within(dialog).getByRole('img', { name: '封面预览' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(callsOf(mock, 'PATCH')).toHaveLength(1));
    const fd = callsOf(mock, 'PATCH')[0].init?.body as FormData;
    expect(fd.get('cover')).toBeNull();
  });

  it('置顶切换：PATCH is_pinned 取反', async () => {
    const mock = stubApi({
      'GET /api/collections/posts/records': listBody([
        makePost({ id: 'post3', title: '普通推文', is_pinned: false }),
      ]),
      'PATCH /api/collections/posts/records': { body: makePost({ id: 'post3' }) },
    });
    renderPage();
    await screen.findByText('普通推文');
    fireEvent.click(within(rowOf('普通推文')).getByRole('button', { name: '置顶' }));
    await waitFor(() => expect(callsOf(mock, 'PATCH')).toHaveLength(1));
    expect(callsOf(mock, 'PATCH')[0].url).toContain('/records/post3');
    expect(callsOf(mock, 'PATCH')[0].init?.body).toBe(JSON.stringify({ is_pinned: true }));
  });
});
