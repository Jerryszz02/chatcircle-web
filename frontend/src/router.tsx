import { Route, Routes } from 'react-router-dom';
import { RequireRole } from './shared/guards';
import {
  AboutPage,
  ActivitiesPage,
  ActivityDetailPage,
  CheckinPage,
  HomePage,
  LoginPage,
  MePage,
  RegisterPage,
  SurveyPage,
  TrainingCheckinPage,
  TrainingsPage,
} from './features/participant/pages';
import {
  AdminActivitiesPage,
  AdminActivityDetailPage,
  AdminAuditPage,
  AdminDashboardPage,
  AdminExportsPage,
  AdminLoginPage,
  AdminRegisterPage,
  AdminTrainingDetailPage,
  AdminTrainingsPage,
} from './features/admin/pages';
import {
  SuperActivitiesPage,
  SuperApprovalsPage,
  SuperAuditPage,
  SuperDashboardPage,
  SuperExportsPage,
  SuperLoginPage,
  SuperOrganizationsPage,
  SuperSystemPage,
} from './features/superadmin/pages';

/**
 * 路由表（technical-design §5.3）。
 * 三个角色端共用单 SPA：参与者端（/，手机优先）、机构管理端（/admin）、超级管理端（/super）。
 * 路由守卫仅作 UX 引导，权限隔离以服务端 API rules / pb_hooks 为准。
 */
export function AppRoutes() {
  return (
    <Routes>
      {/* 参与者端（公开页：首页、关于我们、活动广场、活动详情、报名链路、登录） */}
      <Route path="/" element={<HomePage />} />
      <Route path="/about" element={<AboutPage />} />
      <Route path="/activities" element={<ActivitiesPage />} />
      <Route path="/a/:activityId" element={<ActivityDetailPage />} />
      <Route path="/a/:activityId/register" element={<RegisterPage />} />
      <Route path="/login" element={<LoginPage />} />
      {/* 参与者端（需参与者会话；未登录跳 /login 并记录 redirect 回跳地址） */}
      <Route
        path="/me"
        element={
          <RequireRole role="participant">
            <MePage />
          </RequireRole>
        }
      />
      <Route
        path="/checkin/:token"
        element={
          <RequireRole role="participant">
            <CheckinPage />
          </RequireRole>
        }
      />
      <Route
        path="/trainings"
        element={
          <RequireRole role="participant">
            <TrainingsPage />
          </RequireRole>
        }
      />
      <Route
        path="/training-checkin/:token"
        element={
          <RequireRole role="participant">
            <TrainingCheckinPage />
          </RequireRole>
        }
      />
      <Route
        path="/survey/:qrToken"
        element={
          <RequireRole role="participant">
            <SurveyPage />
          </RequireRole>
        }
      />

      {/* 机构管理端 */}
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route path="/admin/register" element={<AdminRegisterPage />} />
      <Route
        path="/admin/activities"
        element={
          <RequireRole role="admin">
            <AdminActivitiesPage />
          </RequireRole>
        }
      />
      <Route
        path="/admin/activities/:activityId"
        element={
          <RequireRole role="admin">
            <AdminActivityDetailPage />
          </RequireRole>
        }
      />
      <Route
        path="/admin/trainings"
        element={
          <RequireRole role="admin">
            <AdminTrainingsPage />
          </RequireRole>
        }
      />
      <Route
        path="/admin/trainings/:trainingId"
        element={
          <RequireRole role="admin">
            <AdminTrainingDetailPage />
          </RequireRole>
        }
      />
      <Route
        path="/admin/dashboard"
        element={
          <RequireRole role="admin">
            <AdminDashboardPage />
          </RequireRole>
        }
      />
      <Route
        path="/admin/exports"
        element={
          <RequireRole role="admin">
            <AdminExportsPage />
          </RequireRole>
        }
      />
      <Route
        path="/admin/audit"
        element={
          <RequireRole role="admin">
            <AdminAuditPage />
          </RequireRole>
        }
      />

      {/* 超级管理端 */}
      <Route path="/super/login" element={<SuperLoginPage />} />
      <Route
        path="/super/organizations"
        element={
          <RequireRole role="super">
            <SuperOrganizationsPage />
          </RequireRole>
        }
      />
      <Route
        path="/super/approvals"
        element={
          <RequireRole role="super">
            <SuperApprovalsPage />
          </RequireRole>
        }
      />
      <Route
        path="/super/activities"
        element={
          <RequireRole role="super">
            <SuperActivitiesPage />
          </RequireRole>
        }
      />
      <Route
        path="/super/dashboard"
        element={
          <RequireRole role="super">
            <SuperDashboardPage />
          </RequireRole>
        }
      />
      <Route
        path="/super/exports"
        element={
          <RequireRole role="super">
            <SuperExportsPage />
          </RequireRole>
        }
      />
      <Route
        path="/super/audit"
        element={
          <RequireRole role="super">
            <SuperAuditPage />
          </RequireRole>
        }
      />
      <Route
        path="/super/system"
        element={
          <RequireRole role="super">
            <SuperSystemPage />
          </RequireRole>
        }
      />

      <Route path="*" element={<HomePage />} />
    </Routes>
  );
}
