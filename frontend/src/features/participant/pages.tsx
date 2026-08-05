import { PlaceholderPage } from '../../shared/ui/PlaceholderPage';

const SECTION = '参与者端';

export function HomePage() {
  return <PlaceholderPage section={SECTION} title="首页" />;
}

export function ActivityDetailPage() {
  return <PlaceholderPage section={SECTION} title="公开活动详情" />;
}

export function RegisterPage() {
  return <PlaceholderPage section={SECTION} title="报名链路（内嵌自动注册/登录）" />;
}

export function LoginPage() {
  return <PlaceholderPage section={SECTION} title="平台通用登录" />;
}

export function MePage() {
  return <PlaceholderPage section={SECTION} title="我的中心" />;
}

export function CheckinPage() {
  return <PlaceholderPage section={SECTION} title="扫码签到" />;
}

export function SurveyPage() {
  return <PlaceholderPage section={SECTION} title="问卷填写 / 答案查看" />;
}
