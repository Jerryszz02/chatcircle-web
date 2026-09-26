import { AccountActions } from '../components/AccountActions';
import { NotFoundView } from './NotFoundView';

/** SPA 路由级 404（router.tsx 的 path="*" 兜底；原实现回退首页，无法区分未知路径）。 */
export function NotFoundPage() {
  return <NotFoundView message="页面不存在" actions={<AccountActions />} />;
}
