import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { superAuth } from '../../shared/auth';
import { Button, PageLayout } from '../../shared/ui';

/**
 * 超级管理端布局（technical-design §5.3 路由表 /super 前缀）。
 * 顶部导航覆盖：机构、审批、活动、看板、导出、审计、系统；
 * 右侧显示当前账号与退出登录（主动退出 token 立即失效，PRD §12.4）。
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
    <PageLayout
      wide
      section="超级管理端"
      title={title}
      actions={
        <Button variant="secondary" onClick={logout}>
          退出登录
        </Button>
      }
    >
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
        <span className="sa-account">{record?.email ?? record?.id ?? ''}</span>
      </nav>
      {children}
    </PageLayout>
  );
}
