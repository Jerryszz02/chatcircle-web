import { AccountActions } from '../components/AccountActions';
import { PrivacyPageView } from './PrivacyPageView';

/** 隐私政策容器（/privacy）：纯静态页，仅注入账号区插槽。 */
export function PrivacyPage() {
  return <PrivacyPageView actions={<AccountActions />} />;
}
