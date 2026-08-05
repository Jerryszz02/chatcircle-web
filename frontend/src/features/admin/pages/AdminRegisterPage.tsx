import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { adminAuth } from '../../../shared/auth';
import { normalizeApiError, registerAdmin } from '../../../shared/api/http';
import { Button, Input, PageLayout } from '../../../shared/ui';

/** 管理员用户名规则（PRD 未明确，technical-design「待确认」#3：暂套用参与者规则，
 *  含小写归一化——后端 auth.pb.js 存小写，前端先归一化再提交，所见即所存）。 */
const USERNAME_PATTERN = /^[a-z0-9_]{4,20}$/;

/**
 * 邀请码注册（/admin/register，FR-ORG-002/003、AC-02）。
 * 输入邀请码明文 + 用户名 + 密码，服务端单事务校验邀请码并创建 admin_accounts；
 * 注册成功后直接以新凭据登录进入后台。
 */
export function AdminRegisterPage() {
  const navigate = useNavigate();
  const [inviteCode, setInviteCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (adminAuth.isValid()) {
    return <Navigate to="/admin/activities" replace />;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const name = username.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(name)) {
      setError('用户名须为 4–20 位字母、数字或下划线');
      return;
    }
    if (password.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    if (password !== passwordConfirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      await registerAdmin(adminAuth.client, {
        invite_code: inviteCode.trim(),
        username: name,
        password,
      });
      // 注册成功后以新凭据登录（邀请码已被服务端消费，不可复用）。
      await adminAuth.login(name, password);
      navigate('/admin/activities', { replace: true });
    } catch (err) {
      setError(normalizeApiError(err).message || '注册失败，请确认邀请码有效');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageLayout section="机构管理端" title="邀请码注册">
      <form onSubmit={handleSubmit} noValidate>
        <Input
          label="邀请码"
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
          hint="由超级管理员发放的一次性邀请码，注册成功后立即失效"
          required
        />
        <Input
          label="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          hint="4–20 位字母、数字或下划线；大写字母将自动转为小写"
          autoComplete="username"
          required
        />
        <Input
          label="密码"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="至少 8 位"
          autoComplete="new-password"
          required
        />
        <Input
          label="确认密码"
          type="password"
          value={passwordConfirm}
          onChange={(e) => setPasswordConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
        {error ? (
          <p className="cc-error" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" block loading={submitting}>
          注册并登录
        </Button>
      </form>
      <p className="admin-muted admin-section">
        已有账号？<Link to="/admin/login">返回登录</Link>
      </p>
    </PageLayout>
  );
}
