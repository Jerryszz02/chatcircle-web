/**
 * 机构管理端页面统一出口（router.tsx 按既有命名从此导入，路由表见 technical-design §5.3）。
 * 分区样式随页面一并加载（仅本分区生效）。
 */
import './admin.css';

export { AdminLoginPage } from './pages/AdminLoginPage';
export { AdminRegisterPage } from './pages/AdminRegisterPage';
export { AdminActivitiesPage } from './pages/AdminActivitiesPage';
export { AdminActivityDetailPage } from './pages/AdminActivityDetailPage';
export { AdminDashboardPage } from './pages/AdminDashboardPage';
export { AdminExportsPage } from './pages/AdminExportsPage';
export { AdminAuditPage } from './pages/AdminAuditPage';
export { AdminTrainingsPage } from './pages/AdminTrainingsPage';
export { AdminTrainingDetailPage } from './pages/AdminTrainingDetailPage';
