import { Link, NavLink } from 'react-router-dom';
import { HeaderActions } from './HeaderActions';

/**
 * 参与者端公开页站点导航（C 端品牌官网化，2026-08 UI 重构）：吸顶横排。
 * 左：Chat Circles 文字标（logo 占位，待视觉素材替换）；
 * 右：首页 / 现有活动 / 往期活动（独立页 /activities/past）/ 关于我们 + 登录入口。
 * 前缀路径需 end 精确匹配，避免 / 与 /activities 在所有下级路径上恒 active。
 * 登录入口复用 HeaderActions：按当前会话角色切换
 * （未登录出聚合登录菜单，已登录出「我的中心 / 管理面板」），行为不变。
 */
export function SiteHeader() {
  return (
    <header className="ccp-site-header">
      <div className="ccp-site-header-inner">
        <Link to="/" className="ccp-site-logo">
          Chat Circles
        </Link>
        <nav className="ccp-site-nav" aria-label="站点导航">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : undefined)}>
            首页
          </NavLink>
          <NavLink
            to="/activities"
            end
            className={({ isActive }) => (isActive ? 'active' : undefined)}
          >
            现有活动
          </NavLink>
          <NavLink
            to="/activities/past"
            className={({ isActive }) => (isActive ? 'active' : undefined)}
          >
            往期活动
          </NavLink>
          <NavLink to="/about" className={({ isActive }) => (isActive ? 'active' : undefined)}>
            关于我们
          </NavLink>
        </nav>
        <div className="ccp-site-actions">
          <HeaderActions />
        </div>
      </div>
    </header>
  );
}
