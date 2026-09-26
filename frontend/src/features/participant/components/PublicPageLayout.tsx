import type { ReactNode } from 'react';
import { SiteFooter } from './SiteFooter';
import { SiteHeader } from './SiteHeader';

/** Shared participant shell for public content and participant workflows. */
export function PublicPageLayout({
  className,
  children,
}: {
  /** 附加在根元素上的类名（如活动详情页吸底 CTA 预留空间标记 ccp-has-sticky-cta）。 */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`ccp-root ccp-site${className?.split(' ').includes('ccp-home') ? '' : ' ccp-interior'}${className ? ` ${className}` : ''}`}
    >
      <SiteHeader />
      <main className="ccp-site-main">{children}</main>
      <SiteFooter />
    </div>
  );
}
