import { PlaceholderPage } from '../../shared/ui/PlaceholderPage';

const SECTION = '机构管理端';

export function AdminLoginPage() {
  return <PlaceholderPage section={SECTION} title="管理员登录" />;
}

export function AdminRegisterPage() {
  return <PlaceholderPage section={SECTION} title="邀请码注册" />;
}

export function AdminActivitiesPage() {
  return <PlaceholderPage section={SECTION} title="活动列表" />;
}

export function AdminActivityDetailPage() {
  return <PlaceholderPage section={SECTION} title="活动详情（报名审核 / 签到控制台 / 问卷管理）" />;
}

export function AdminDashboardPage() {
  return <PlaceholderPage section={SECTION} title="本机构看板" />;
}

export function AdminExportsPage() {
  return <PlaceholderPage section={SECTION} title="本机构导出" />;
}

export function AdminAuditPage() {
  return <PlaceholderPage section={SECTION} title="本机构审计日志" />;
}
