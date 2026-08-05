import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { adminAuth } from '../../../shared/auth';
import type { AdminAccountRecord } from '../../../shared/api/types';
import { Button, PageLayout } from '../../../shared/ui';

/**
 * 机构管理端布局（technical-design §5.3 /admin 分区）。
 * 顶部导航：活动 / 看板 / 导出 / 审计；右侧显示当前管理员与主动退出
 * （管理后台不做无操作自动退出，但必须具备主动退出机制，PRD §12.4）。
 */
export function AdminLayout({
  title,
  actions,
  wide = true,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
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
      <nav className="admin-nav" aria-label="机构管理端导航">
        <NavLink to="/admin/activities" className={navClass}>
          活动
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
        <span className="admin-nav-spacer" />
        <span className="admin-nav-user">{record?.display_name || record?.username || ''}</span>
        <Button variant="secondary" onClick={logout}>
          退出登录
        </Button>
      </nav>
      <PageLayout section="机构管理端" title={title} actions={actions} wide={wide}>
        {children}
      </PageLayout>
    </div>
  );
}

function navClass({ isActive }: { isActive: boolean }) {
  return `admin-nav-link${isActive ? ' admin-nav-link-active' : ''}`;
}
