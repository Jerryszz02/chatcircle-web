import { useParams } from 'react-router-dom';
import { ClientOnly } from '../../../public/ClientOnly';
import { usePublicActivity } from '../lib/usePublicActivity';
import { AccountActions } from '../components/AccountActions';
import { MyPairingCard } from '../components/MyPairingCard';
import { ActivityDetailPageView } from './ActivityDetailPageView';

/**
 * 公开活动详情容器（/a/:activityId，FR-ACT-003：未登录可看，点击报名时才要求登录）。
 * 数据经 usePublicActivity 获取（含 registration_fields，仅报名链路使用，
 * 不下发给本页视图，避免进入公开 SSR HTML）。
 * 「我的现场编号」配对卡（MyPairingCard 依赖 localStorage 会话）经 ClientOnly 插槽注入，
 * 服务端渲染与 hydrate 首帧不含该卡片。
 */
export function ActivityDetailPage() {
  const { activityId = '' } = useParams();
  const { data, error, loading, reload } = usePublicActivity(activityId);

  return (
    <ActivityDetailPageView
      activityId={activityId}
      loading={loading}
      error={error ? { status: error.status, message: error.message } : null}
      detail={data ? { activity: data.activity, registration: data.registration } : null}
      onRetry={reload}
      personalSlot={
        <ClientOnly>
          <MyPairingCard activityId={activityId} />
        </ClientOnly>
      }
      actions={<AccountActions />}
    />
  );
}
