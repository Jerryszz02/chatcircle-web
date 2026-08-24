import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { adminAuth } from '../../../shared/auth';
import type { AdminAccountRecord } from '../../../shared/api/types';
import { Button } from '../../../shared/ui';

/**
 * 机构管理端布局（technical-design §5.3 /admin 分区）。
 * 极简公益科技风：左侧 240px 侧栏 + 顶部上下文栏（docs/planning/ui-design.md）。
 * 侧栏含品牌标识、主导航（活动 / 培训 / 看板 / 导出 / 审计日志）、当前管理员与主动退出
 * （管理后台不做无操作自动退出，但必须具备主动退出机制，PRD §12.4）。
 */
export function AdminLayout({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const record = adminAuth.record as AdminAccountRecord | null;

  const logout = useCallback(() => {
    adminAuth.logout();
    navigate('/admin/login', { replace: true });
  }, [navigate]);

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <span className="admin-brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          <span className="admin-brand-text">
            <strong>ChatCircle</strong>
            <span className="admin-brand-scope">机构端</span>
          </span>
        </div>
        <nav className="admin-nav" aria-label="机构管理端导航">
          <NavLink to="/admin/activities" className={navClass}>
            活动
          </NavLink>
          <NavLink to="/admin/trainings" className={navClass}>
            培训
          </NavLink>
          <NavLink to="/admin/dashboard" className={navClass}>
            看板
          </NavLink>
          <NavLink to="/admin/exports" className={navClass}>
            导出
          </NavLink>
          <NavLink to="/admin/audit" className={navClass}>
            审计日志
          </NavLink>
        </nav>
        <div className="admin-sidebar-foot">
          <span className="admin-nav-user">{record?.display_name || record?.username || ''}</span>
          <div className="admin-sidebar-foot-actions">
            <Link to="/" className="admin-foot-link">
              返回首页
            </Link>
            <Button variant="secondary" onClick={logout}>
              退出登录
            </Button>
          </div>
        </div>
      </aside>
      <div className="admin-main">
        <header className="admin-topbar">
          <h1 className="admin-topbar-title">{title}</h1>
          {actions ? <div className="admin-topbar-actions">{actions}</div> : null}
        </header>
        <main className="admin-content">{children}</main>
      </div>
    </div>
  );
}

function navClass({ isActive }: { isActive: boolean }) {
  return `admin-nav-link${isActive ? ' admin-nav-link-active' : ''}`;
}
