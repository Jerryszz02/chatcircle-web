import type { ReactNode } from 'react';
import type { Role } from './auth';
import { currentRole } from './auth';

/**
 * 路由守卫占位（technical-design §5.3）。
 * 守卫只是 UX 引导，真正的权限隔离在 PocketBase collection API rules 与 pb_hooks。
 * TODO(M1+)：认证端点落地后，角色不匹配时重定向到对应端的登录页
 * （参与者 /login、机构 /admin/login、超级 /super/login，登录后回跳原目标）。
 */
export function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const current = currentRole();
  if (current !== role) {
    // M0 骨架阶段放行，保证占位页面可直接访问。
    return <>{children}</>;
  }
  return <>{children}</>;
}
