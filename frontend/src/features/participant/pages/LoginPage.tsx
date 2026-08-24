import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { hasAnySession, participantAuth } from '../../../shared/auth';
import { Card, PageLayout } from '../../../shared/ui';
import { ParticipantAuthForm } from '../components/ParticipantAuthForm';
import { sanitizeRedirect } from '../lib/redirect';

/**
 * 平台通用登录页（/login，FR-AUTH-008）。
 * - 不提供注册入口：账号在活动报名链路中自动创建（PRD §5.2 账号规则）；
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
      <div className="ccp-auth-mark" aria-hidden="true">
        <span />
        <span />
      </div>
      <Card>
        <ParticipantAuthForm
          submitLabel="登录"
          intro="输入您的用户名和密码登录。"
          onSuccess={() => navigate(target, { replace: true })}
        />
      </Card>
      <p className="cc-hint">
        还没有账号？账号在活动现场的报名流程中自动创建，本页不提供注册。
      </p>
    </PageLayout>
  );
}
