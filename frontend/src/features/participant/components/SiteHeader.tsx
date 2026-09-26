import type { ReactNode } from 'react';
import chatCirclesLogo from '../../../assets/brand/chat-circles-logo.png';
import { NavAnchor } from '../../../public/nav';
import { DefaultAccountLink } from './DefaultAccountLink';

/**
 * 参与者端公开页站点导航（C 端品牌官网化，2026-08 UI 重构）：吸顶横排。
 * 左：Chat Circles 品牌标（logo 图形 + 文字）；
 * 右：首页 / 现有活动 / 往期活动（独立页 /activities/past）/ 关于我们 / 返回官网 + 账号入口。
 * 前缀路径需 end 精确匹配，避免 / 与 /activities 在所有下级路径上恒 active。
 *
 * 本组件为 SSR 安全的纯组件：导航一律 document navigation（public/nav），
 * 账号区经 actions 插槽注入（缺省为纯 <a> 登录链接 DefaultAccountLink），
 * 会话敏感的 HeaderActions 由 SPA 侧以 AccountActions（ClientOnly）注入。
 */
export function SiteHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className="ccp-site-header">
      <div className="ccp-site-header-inner">
        <NavAnchor href="/" className="ccp-site-logo">
          {/* logo 图形为装饰性元素：链接可访问名由文字「Chat Circles」提供 */}
          <img src={chatCirclesLogo} alt="" className="ccp-site-logo-img" />
          Chat Circles
        </NavAnchor>
        <nav className="ccp-site-nav" aria-label="站点导航">
          <NavAnchor href="/" end className={({ isActive }) => (isActive ? 'active' : undefined)}>
            首页
          </NavAnchor>
          <NavAnchor
            href="/activities"
            end
            className={({ isActive }) => (isActive ? 'active' : undefined)}
          >
            现有活动
          </NavAnchor>
          <NavAnchor
            href="/activities/past"
            className={({ isActive }) => (isActive ? 'active' : undefined)}
          >
            往期活动
          </NavAnchor>
          <NavAnchor href="/about" className={({ isActive }) => (isActive ? 'active' : undefined)}>
            关于我们
          </NavAnchor>
          <a href="https://empact.cn/">返回官网</a>
        </nav>
        <div className="ccp-site-actions">{actions ?? <DefaultAccountLink />}</div>
      </div>
    </header>
  );
}
