import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { hasAnySession, participantAuth } from '../../../shared/auth';
import { Card, PageLayout } from '../../../shared/ui';
import { ParticipantAccessPanel } from '../components/ParticipantAccessPanel';
import { sanitizeRedirect } from '../lib/redirect';

/**
 * 平台通用登录页（/login）。
 * - 手机号 + 验证码是主登录/注册入口；
 * - 存量用户名账号可登录后绑定手机号，participant_id 与历史记录不变；
 * - 支持 redirect 参数回跳（从活动/签到/问卷链接跳来，登录后回到原目标）；
 * - 无回跳地址时进入「我的」中心（FR-PAR-004）。
 */
export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const target = sanitizeRedirect(searchParams.get('redirect')) ?? '/me';

  // 已登录直接到目标页（含重新访问 /login 的场景）。
  if (participantAuth.isValid()) {
    return <Navigate to={target} replace />;
  }
  // 单会话互斥：已登录其它身份（机构/超管）时须先退出，回首页进入对应面板。
  if (hasAnySession()) {
    return <Navigate to="/" replace />;
  }

  return (
    <PageLayout section="参与者端" title="平台通用登录" className="ccp-root" backTo="/">
      <div className="cc-auth-mark" aria-hidden="true">
        <span />
        <span />
      </div>
      <Card>
        <ParticipantAccessPanel onSuccess={() => navigate(target, { replace: true })} />
      </Card>
      <p className="cc-hint">
        首次验证手机号会自动创建账号；已有手机号会直接登录。
      </p>
    </PageLayout>
  );
}
