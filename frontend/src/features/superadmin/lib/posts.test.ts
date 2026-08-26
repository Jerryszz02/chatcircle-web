import { describe, expect, it } from 'vitest';
import { hasPostFormErrors, validatePostForm } from './posts';

/**
 * 推文表单校验（与 pb_hooks/posts.pb.js 服务端口径一致）：
 * title 必填；body_md 与 external_url 至少填一个；外链仅允许 http/https。
 */
describe('validatePostForm 推文表单校验', () => {
  it('标题必填（含纯空白）', () => {
    const errors = validatePostForm({ title: '  ', bodyMd: '正文', externalUrl: '' });
    expect(errors.title).toBe('请填写标题');
    expect(hasPostFormErrors(errors)).toBe(true);
  });

  it('正文与外链全空 → 至少填一项', () => {
    const errors = validatePostForm({ title: '标题', bodyMd: ' ', externalUrl: '' });
    expect(errors.content).toBe('正文与外链至少填写一项');
    expect(hasPostFormErrors(errors)).toBe(true);
  });

  it('仅正文 / 仅外链 / 两者皆有均可通过', () => {
    expect(
      hasPostFormErrors(validatePostForm({ title: 't', bodyMd: '正文', externalUrl: '' })),
    ).toBe(false);
    expect(
      hasPostFormErrors(
        validatePostForm({ title: 't', bodyMd: '', externalUrl: 'https://example.com/a' }),
      ),
    ).toBe(false);
    expect(
      hasPostFormErrors(
        validatePostForm({ title: 't', bodyMd: '正文', externalUrl: 'http://example.com' }),
      ),
    ).toBe(false);
  });

  it('外链仅允许 http/https（协议注入与相对路径拒绝，大小写不敏感）', () => {
    expect(
      validatePostForm({ title: 't', bodyMd: '', externalUrl: 'javascript:alert(1)' }).externalUrl,
    ).toBe('外链仅允许 http/https 协议');
    expect(
      validatePostForm({ title: 't', bodyMd: '', externalUrl: 'ftp://example.com' }).externalUrl,
    ).toBe('外链仅允许 http/https 协议');
    expect(
      validatePostForm({ title: 't', bodyMd: '', externalUrl: '/relative/path' }).externalUrl,
    ).toBe('外链仅允许 http/https 协议');
    expect(
      hasPostFormErrors(validatePostForm({ title: 't', bodyMd: '', externalUrl: 'HTTP://a.com' })),
    ).toBe(false);
  });
});
