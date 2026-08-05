import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { adminAuth } from '../../../shared/auth';
import { normalizeApiError } from '../../../shared/api/http';
import { Button, Input, PageLayout } from '../../../shared/ui';

/**
 * 管理员登录（/admin/login，technical-design §5.3）。
 * admin_accounts 标准用户名+密码认证（FR-AUTH-009 同型）；
 * 注册走一次性邀请码（/admin/register，FR-ORG-002）；登录限流由服务端执行（FR-AUTH-007）。
 */
export function AdminLoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (adminAuth.isValid()) {
    return <Navigate to="/admin/activities" replace />;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await adminAuth.login(username.trim(), password);
      navigate('/admin/activities', { replace: true });
    } catch (err) {
      setError(normalizeApiError(err).message || '登录失败，请检查用户名与密码');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageLayout section="机构管理端" title="管理员登录">
      <form onSubmit={handleSubmit} noValidate>
        <Input
          label="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
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
        <Button type="submit" block loading={submitting}>
          登录
        </Button>
      </form>
      <p className="admin-muted admin-section">
        还没有账号？请使用超级管理员发放的一次性邀请码 <Link to="/admin/register">注册管理员账号</Link>
        。
      </p>
    </PageLayout>
  );
}
