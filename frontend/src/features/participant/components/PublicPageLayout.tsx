import type { ReactNode } from 'react';
import { SiteFooter } from './SiteFooter';
import { SiteHeader } from './SiteHeader';

/**
 * 公开内容页与参与者工作流共用的站点外壳（SSR 安全纯组件）。
 * 账号区经 actions 插槽透传给 SiteHeader，缺省渲染纯 <a> 登录链接
 * （DefaultAccountLink）；SPA 侧传入 AccountActions（ClientOnly + HeaderActions）。
 * 本模块及其依赖不得 import 会话/pb client 相关模块。
 */
export function PublicPageLayout({
  className,
  actions,
  children,
}: {
  /** 附加在根元素上的类名（如活动详情页吸底 CTA 预留空间标记 ccp-has-sticky-cta）。 */
  className?: string;
  /** 站点头部账号区插槽；缺省为默认登录链接。 */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`ccp-root ccp-site${className?.split(' ').includes('ccp-home') ? '' : ' ccp-interior'}${className ? ` ${className}` : ''}`}
    >
      <SiteHeader actions={actions} />
      <main className="ccp-site-main">{children}</main>
      <SiteFooter />
    </div>
  );
}
