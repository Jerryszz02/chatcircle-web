import { PlaceholderPage } from '../../../shared/ui/PlaceholderPage';

/**
 * 首页：technical-design §5.3 参与者端路由表未定义首页内容，
 * 且 V1 无公开活动广场（FR-ACT-002，活动仅链接/二维码可达），保持占位页。
 */
export function HomePage() {
  return <PlaceholderPage section="参与者端" title="首页" />;
}
