import type { ReactNode } from 'react';
import { SiteFooter } from './SiteFooter';
import { SiteHeader } from './SiteHeader';

/**
 * 参与者端公开页布局（C 端品牌官网化，2026-08 UI 重构）：
 * 吸顶站点导航 + 内容容器 + 站点页脚，用于首页 / 活动列表 / 活动详情 / 关于我们。
 * 功能流程页（登录 / 报名 / 签到 / 问卷 / 我的中心等）仍使用 shared/ui 的 PageLayout。
 * .ccp-root 挂在根元素上：参与者端私有 token（薄荷辅助色）与页面底色（body:has 米白）对整个公开页
 * （含导航与页脚）生效；V2 品牌色板本身已在 global.css :root 全端统一。
 */
export function PublicPageLayout({
  className,
  children,
}: {
  /** 附加在根元素上的类名（如活动详情页吸底 CTA 预留空间标记 ccp-has-sticky-cta）。 */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`ccp-root ccp-site${className ? ` ${className}` : ''}`}>
      <SiteHeader />
      <main className="ccp-site-main">{children}</main>
      <SiteFooter />
    </div>
  );
}
