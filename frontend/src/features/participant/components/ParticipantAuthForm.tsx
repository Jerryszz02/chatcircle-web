import { useState } from 'react';
import type { FormEvent } from 'react';
import { participantAuth } from '../../../shared/auth';
import { normalizeApiError } from '../../../shared/api/http';
import { Button, Input } from '../../../shared/ui';
import {
  normalizeUsername,
  USERNAME_MAX,
  USERNAME_PRIVACY_NOTICE,
  USERNAME_RULE_HINT,
  validatePassword,
  validateUsername,
} from '../lib/username';

/**
 * 存量用户名账号登录表单，仅由手机号主入口中的迁移流程使用：
 * - 用户名不存在或密码错误 → 服务端返回同形错误，绝不创建账号或签发 token；
 * - 已有账号校验密码成功后必须继续绑定手机号；
 * - 连续失败触发限流后的拒绝文案同样来自服务端（FR-AUTH-007）。
 * 用户名上限与服务端 pattern（4–20 位）对齐。
 */
export function ParticipantAuthForm({
  submitLabel = '继续',
  intro,
  showPrivacyNotice = false,
  onSuccess,
}: {
  submitLabel?: string;
  /** 表单上方的场景说明（报名链路 / 登录页文案不同）。 */
  intro?: string;
  /** 是否展示用户名隐私提示（PRD §11.1 原文；注册发生的报名链路必须展示）。 */
  showPrivacyNotice?: boolean;
  onSuccess: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [usernameError, setUsernameError] = useState<string | undefined>();
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const uErr = validateUsername(username);
    const pErr = validatePassword(password);
    setUsernameError(uErr ?? undefined);
    setPasswordError(pErr ?? undefined);
    setFormError(undefined);
    if (uErr || pErr) return;

    setSubmitting(true);
    try {
      await participantAuth.login(normalizeUsername(username), password);
      onSuccess();
    } catch (err) {
      setFormError(normalizeApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {intro ? <p className="cc-notice">{intro}</p> : null}
      {showPrivacyNotice ? (
        <p className="cc-notice cc-notice-privacy">{USERNAME_PRIVACY_NOTICE}</p>
      ) : null}
      <Input
        label="用户名"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        hint={USERNAME_RULE_HINT}
        error={usernameError}
        required
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        maxLength={USERNAME_MAX}
      />
      <Input
        label="密码"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint="至少 8 位；请牢记，平台不提供找回"
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
        {submitLabel}
      </Button>
    </form>
  );
}
