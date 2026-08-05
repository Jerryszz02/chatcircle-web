import { PlaceholderPage } from '../../shared/ui/PlaceholderPage';

const SECTION = '超级管理端';

export function SuperLoginPage() {
  return <PlaceholderPage section={SECTION} title="超级管理员登录" />;
}

export function SuperOrganizationsPage() {
  return <PlaceholderPage section={SECTION} title="机构管理与邀请码" />;
}

export function SuperApprovalsPage() {
  return <PlaceholderPage section={SECTION} title="活动发布审批" />;
}

export function SuperActivitiesPage() {
  return <PlaceholderPage section={SECTION} title="全部活动监管" />;
}

export function SuperDashboardPage() {
  return <PlaceholderPage section={SECTION} title="全局看板" />;
}

export function SuperExportsPage() {
  return <PlaceholderPage section={SECTION} title="全局导出" />;
}

export function SuperAuditPage() {
  return <PlaceholderPage section={SECTION} title="全局审计" />;
}

export function SuperSystemPage() {
  return <PlaceholderPage section={SECTION} title="系统状态（备份告警）" />;
}
