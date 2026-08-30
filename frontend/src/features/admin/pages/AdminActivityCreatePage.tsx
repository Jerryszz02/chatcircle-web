import { AdminLayout } from '../components/AdminLayout';
import { ActivityCreateWizard } from '../components/ActivityCreateWizard';

/**
 * 活动创建向导页（/admin/activities/new，PRD §4.1 分步向导）。
 * 多步骤表单按 UI 规范使用独立页面而非弹窗（ui-design「超过 6 个字段或多步骤进独立页面」）。
 */
export function AdminActivityCreatePage() {
  return (
    <AdminLayout title="创建活动">
      <ActivityCreateWizard />
    </AdminLayout>
  );
}
