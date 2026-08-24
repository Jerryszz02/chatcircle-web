import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Role } from './pocketbase';
import { authFor, hasAnySession } from './auth';
import { LOGIN_PATHS } from './pocketbase';
import { useSessionSnapshot } from './session';
import { ForbiddenPage } from './ui/ForbiddenPage';

/**
 * 路由守卫（technical-design §5.3）。
 *
 * - 未登录：跳对应端登录页（参与者 /login、机构 /admin/login、超级 /super/login）；
 *   参与者端记录 redirect 回跳地址，登录后回到原目标（§5.3 路由表 /login 约定、AC-22）。
 * - 已登录但角色不符：渲染 403 占位页。
 *
 * 守卫只是 UX 引导，真正的权限隔离在 collection API rules 与 pb_hooks（§5.5）。
 */

export function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const location = useLocation();
  useSessionSnapshot();

  if (authFor(role).isValid()) {
    return <>{children}</>;
  }
  // 已登录其它角色 → 角色不符，403 占位页。
  if (hasAnySession()) {
    return <ForbiddenPage requiredRole={role} />;
  }
  const loginPath = LOGIN_PATHS[role];
  if (role === 'participant') {
    const redirect = location.pathname + location.search;
    return <Navigate to={`${loginPath}?redirect=${encodeURIComponent(redirect)}`} replace />;
  }
  return <Navigate to={loginPath} replace />;
}
