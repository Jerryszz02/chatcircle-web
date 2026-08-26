import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { normalizeApiError } from '../../../shared/api/http';
import { hasAnySession, superAuth } from '../../../shared/auth';
import { Button, Card, Input, PageLayout } from '../../../shared/ui';

/**
 * 超级管理员登录页（/super/login）。
 * _superusers 账号初始部署时创建，全平台仅一个（FR-AUTH-009）；
 * V1 无创建/停用/更换超管的产品界面，登录限流由服务端统一执行（FR-AUTH-007）。
 */
export function SuperLoginPage() {
  const navigate = useNavigate();
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 已持有有效超管会话则直接进入后台
  if (superAuth.isValid()) {
    return <Navigate to="/super/dashboard" replace />;
  }
  // 单会话互斥：已登录其它身份（参与者/机构管理员）时须先退出，回首页进入对应面板。
  if (hasAnySession()) {
    return <Navigate to="/" replace />;
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await superAuth.login(identity.trim(), password);
      navigate('/super/dashboard', { replace: true });
    } catch (err) {
      setError(normalizeApiError(err).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <PageLayout section="超级管理端" backTo="/" className="cc-auth-page">
      <div className="cc-auth-mark" aria-hidden="true">
        <span />
        <span />
      </div>
      <Card>
        <h1 className="page-title">超级管理员登录</h1>
        <form onSubmit={(e) => void onSubmit(e)}>
          <Input
            label="用户名或邮箱"
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
            autoComplete="username"
            required
          />
          <Input
            label="密码"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          {error ? (
            <p className="cc-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" block loading={loading}>
            登录
          </Button>
        </form>
      </Card>
    </PageLayout>
  );
}
