import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { stubApi, unstubApi } from '../../../test/mockApi';
import { PostPage } from './PostPage';
function mount() {
  return render(
    <MemoryRouter initialEntries={['/posts/post1']}>
      <Routes>
        <Route path="/posts/:postId" element={<PostPage />} />
      </Routes>
    </MemoryRouter>,
  );
}
afterEach(unstubApi);
describe('文章全文', () => {
  it('显示超过摘要长度的正文，同时不执行 HTML 或加载远程图片', async () => {
    stubApi({
      'GET /api/collections/posts/records/post1': {
        status: 200,
        body: {
          id: 'post1',
          title: '活动回顾',
          body_md:
            '正文'.repeat(100) +
            '\n\n**全文结尾**\n\n<img src="x" onerror="alert(1)">\n\n![远程图片](https://example.com/tracker.png)\n\n[危险链接](javascript:alert(1))',
        },
      },
    });
    const { container } = mount();
    await screen.findByText('全文结尾');
    expect(container.querySelector('strong')).toHaveTextContent('全文结尾');
    expect(container.querySelector('img[src="https://example.com/tracker.png"]')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });
  it('隐藏或不存在的文章显示错误，不展示正文', async () => {
    stubApi({ 'GET /api/collections/posts/records/post1': { status: 404, body: { message: 'Not found' } } });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('文章不存在');
  });
});
