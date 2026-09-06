import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { hasAnySession } from '../../../shared/auth';
import { normalizeApiError } from '../../../shared/api/http';
import { Button, Input, PageLayout } from '../../../shared/ui';
import {
  confirmAdminEmail,
  normalizeEmail,
  requestAdminEmail,
  requestAdminOTP,
  resetAdminPassword,
  validEmail,
  verifyAdminOTP,
} from '../lib/emailAuth';

type Mode = 'otp' | 'verify' | 'reset';
export function AdminEmailPage({ mode }: { mode: Mode }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [otpId, setOtpId] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    // 邮件 token 只存组件内存；从地址栏移除，避免后续复制/历史记录带出。
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
  if (mode === 'otp' && hasAnySession()) return <Navigate to="/" replace />;
  const title = mode === 'otp' ? '邮箱验证码登录' : mode === 'verify' ? '验证管理员邮箱' : '找回管理员密码';
  async function submit() {
    setError('');
    setMessage('');
    if (!token && !otpId && !validEmail(normalizeEmail(email))) {
      setError('请输入有效的邮箱地址');
      return;
    }
    if (otpId && !code.trim()) {
      setError('请输入邮件验证码');
      return;
    }
    if (token && mode === 'reset' && (password.length < 8 || password !== confirm)) {
      setError('密码至少 8 位，两次输入须一致');
      return;
    }
    setBusy(true);
    try {
      if (token && mode === 'verify') {
        await confirmAdminEmail(token);
        setMessage('邮箱已验证，可以返回登录或申请找回密码。');
      } else if (token && mode === 'reset') {
        await resetAdminPassword(token, password, confirm);
        setPassword('');
        setConfirm('');
        setMessage('密码已更新，请使用新密码登录。');
      } else if (mode === 'otp') {
        if (otpId) {
          await verifyAdminOTP(otpId, code.trim());
          navigate('/admin/activities', { replace: true });
        } else {
          const result = await requestAdminOTP(email);
          setOtpId(result.otpId);
          setMessage('如邮箱已注册且允许登录，你将收到验证码，请在 5 分钟内输入。');
        }
      } else {
        await requestAdminEmail(email, mode);
        setMessage('如果账号满足条件，我们会发送邮件。请检查收件箱和垃圾邮件；未收到时稍后重试或联系运营人员。');
      }
    } catch (err) {
      setError(normalizeApiError(err).message || '操作失败，请重新申请邮件后重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageLayout section="机构管理端" title={title} backTo="/admin/login" className="cc-auth-page">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        {!token && !otpId ? (
          <Input
            label="注册邮箱"
            type="email"
            autoComplete="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        ) : null}
        {otpId ? (
          <>
            <Input
              label="邮件验证码"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            <button
              type="button"
              className="cc-link-button"
              onClick={() => {
                setOtpId('');
                setCode('');
              }}
            >
              重新申请验证码
            </button>
          </>
        ) : null}
        {token && mode === 'reset' ? (
          <>
            <Input
              label="新密码"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <Input
              label="确认新密码"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </>
        ) : null}
        {mode === 'reset' && !token ? (
          <p className="cc-hint">
            只有已验证邮箱可找回密码。尚未验证时，请先 <Link to="/admin/verify-email">验证邮箱</Link>。
          </p>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
        {error ? (
          <p role="alert" className="cc-error">
            {error}
          </p>
        ) : null}
        <Button type="submit" block loading={busy} disabled={Boolean(token && message)}>
          {token ? (mode === 'verify' ? '确认验证邮箱' : '保存新密码') : otpId ? '验证并登录' : '发送邮件'}
        </Button>
      </form>
      <p>
        <Link to="/admin/login">返回管理员登录</Link>
      </p>
    </PageLayout>
  );
}
