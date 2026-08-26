/**
 * 超级管理端页面出口（technical-design §5.3 /super 路由分区）。
 * router.tsx 仅依赖本文件的组件导出；各页面实现见 pages/ 目录。
 */
import './superadmin.css';

export { SuperLoginPage } from './pages/LoginPage';
export { SuperOrganizationsPage } from './pages/OrganizationsPage';
export { SuperApprovalsPage } from './pages/ApprovalsPage';
export { SuperActivitiesPage } from './pages/ActivitiesPage';
export { SuperPostsPage } from './pages/PostsPage';
export { SuperDashboardPage } from './pages/DashboardPage';
export { SuperExportsPage } from './pages/ExportsPage';
export { SuperAuditPage } from './pages/AuditPage';
export { SuperSystemPage } from './pages/SystemPage';
