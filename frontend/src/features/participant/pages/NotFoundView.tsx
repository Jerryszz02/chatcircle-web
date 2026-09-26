import type { ReactNode } from 'react';
import { NavAnchor } from '../../../public/nav';
import { PublicPageLayout } from '../components/PublicPageLayout';

/**
 * 404 视图（SSR 安全纯组件）：SPA 路由兜底与服务端 404 通用页共用，
 * 文案由调用方给出（SPA 为「页面不存在」；服务端为「内容不存在或已下线」，
 * 不泄露草稿/隐藏内容的存在性）。
 */
export function NotFoundView({
  message,
  actions,
}: {
  message: string;
  /** 站点头部账号区插槽；缺省为默认登录链接（服务端渲染口径）。 */
  actions?: ReactNode;
}) {
  return (
    <PublicPageLayout actions={actions}>
      <section className="ccp-reading">
        <h1>{message}</h1>
        <div className="cc-actions">
          <NavAnchor href="/" className="cc-btn cc-btn-primary">
            返回首页
          </NavAnchor>{' '}
          <NavAnchor href="/activities" className="cc-btn cc-btn-secondary">
            浏览活动
          </NavAnchor>
        </div>
      </section>
    </PublicPageLayout>
  );
}
