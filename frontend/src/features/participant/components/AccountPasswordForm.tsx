import { useState } from 'react';
import type { FormEvent } from 'react';
import { normalizeApiError } from '../../../shared/api/http';
import { participantAuth } from '../../../shared/auth';
import { Button, Input } from '../../../shared/ui';
import { validatePassword } from '../lib/username';

/**
 * 账号密码登录主入口（T2）：身份可以是用户名或手机号（服务端按形态分别用
 * username / phone_lookup_hash 查找）；账号不存在与密码错误同形响应，
 * 连续失败限流文案来自服务端（FR-AUTH-007）。
 */
export function AccountPasswordForm({ onSuccess }: { onSuccess: () => void }) {
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [identityError, setIdentityError] = useState<string | undefined>();
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const iErr = identity.trim() === '' ? '请输入用户名或手机号' : null;
    const pErr = validatePassword(password);
    setIdentityError(iErr ?? undefined);
    setPasswordError(pErr ?? undefined);
    setFormError(undefined);
    if (iErr || pErr) return;

    setSubmitting(true);
    try {
      await participantAuth.login(identity.trim(), password);
      onSuccess();
    } catch (err) {
      setFormError(normalizeApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <Input
        label="用户名或手机号"
        value={identity}
        onChange={(e) => setIdentity(e.target.value)}
        error={identityError}
        required
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
      />
      <Input
        label="密码"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={passwordError}
        required
        autoComplete="current-password"
      />
      {formError ? (
        <p className="cc-error" role="alert">
          {formError}
        </p>
      ) : null}
      <Button type="submit" block loading={submitting}>
        登录
      </Button>
    </form>
  );
}
