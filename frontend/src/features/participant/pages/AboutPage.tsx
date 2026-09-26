import { AccountActions } from '../components/AccountActions';
import { AboutPageView } from './AboutPageView';

/** 关于我们容器（/about）：纯静态页，仅注入账号区插槽。 */
export function AboutPage() {
  return <AboutPageView actions={<AccountActions />} />;
}
