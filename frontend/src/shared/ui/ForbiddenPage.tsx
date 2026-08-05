import { Link } from 'react-router-dom';
import type { Role } from '../pocketbase';
import { PageLayout } from './PageLayout';

/**
 * 403 占位页：已登录但角色不符时由 RequireRole 渲染（technical-design §5.3）。
 * 守卫只是 UX 引导，真正的权限隔离在服务端 API rules 与 pb_hooks。
 */
export function ForbiddenPage({ requiredRole }: { requiredRole?: Role }) {
  return (
    <PageLayout title="403 无权访问">
      <p>
        当前账号{requiredRole ? '不是该页面所需的角色（' + ROLE_LABELS[requiredRole] + '）' : ''}
        ，无权访问此页面。
      </p>
      <p>
        <Link to="/">返回首页</Link>
      </p>
    </PageLayout>
  );
}

const ROLE_LABELS: Record<Role, string> = {
  participant: '参与者',
  admin: '机构管理员',
  super: '超级管理员',
};
