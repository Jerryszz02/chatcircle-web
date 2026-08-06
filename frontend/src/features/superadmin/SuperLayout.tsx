import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { superAuth } from '../../shared/auth';
import { Button } from '../../shared/ui';

/**
 * 超级管理端布局（technical-design §5.3 路由表 /super 前缀）。
 * 与机构端共享设计系统：左侧固定侧栏 + 顶部上下文栏；
 * 侧栏显式标注「平台级」上下文，避免跨机构误操作（ui-design §3.3）。
 * 导航覆盖：机构、审批、活动、看板、导出、审计、系统；
 * 底部显示当前账号与退出登录（主动退出 token 立即失效，PRD §12.4）。
 */

const NAV_ITEMS = [
  { to: '/super/organizations', label: '机构与邀请码' },
  { to: '/super/approvals', label: '发布审批' },
  { to: '/super/activities', label: '活动监管' },
  { to: '/super/dashboard', label: '全局看板' },
  { to: '/super/exports', label: '全局导出' },
  { to: '/super/audit', label: '全局审计' },
  { to: '/super/system', label: '系统与模板' },
] as const;

export function SuperLayout({ title, children }: { title: string; children: ReactNode }) {
  const navigate = useNavigate();
  const record = superAuth.record;

  const logout = () => {
    superAuth.logout();
    navigate('/super/login', { replace: true });
  };

  return (
    <div className="sa-shell">
      <aside className="sa-sidebar">
        <div className="sa-brand">
          <span className="sa-brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          <span className="sa-brand-text">
            <strong>ChatCircle</strong>
            <span className="sa-brand-scope">平台级 · 超级管理端</span>
          </span>
        </div>
        <nav className="sa-layout-nav" aria-label="超级管理端导航">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `sa-nav-link${isActive ? ' active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sa-sidebar-foot">
          <span className="sa-account">{record?.email ?? record?.id ?? ''}</span>
          <div className="sa-sidebar-foot-actions">
            <Link to="/" className="sa-foot-link">
              返回首页
            </Link>
            <Button variant="secondary" onClick={logout}>
              退出登录
            </Button>
          </div>
        </div>
      </aside>
      <div className="sa-main">
        <header className="sa-topbar">
          <h1 className="sa-topbar-title">{title}</h1>
        </header>
        <main className="sa-content">{children}</main>
      </div>
    </div>
  );
}
