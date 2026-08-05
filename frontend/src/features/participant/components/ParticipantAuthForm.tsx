import { useState } from 'react';
import type { FormEvent } from 'react';
import { participantAuth } from '../../../shared/auth';
import { normalizeApiError } from '../../../shared/api/http';
import { Button, Input } from '../../../shared/ui';
import {
  normalizeUsername,
  USERNAME_PRIVACY_NOTICE,
  USERNAME_RULE_HINT,
  validatePassword,
  validateUsername,
} from '../lib/username';

/**
 * 用户名密码单框（FR-AUTH-001：自动识别登录或注册）。
 * 报名链路与通用登录页复用：
 * - 用户名不存在 → 服务端自动创建账号并登录；存在 → 校验密码登录；
 * - 错误密码由服务端返回错误（不建号，AC-06），前端原样展示服务端文案；
 * - 连续失败触发限流后的拒绝文案同样来自服务端（FR-AUTH-007）。
 * 本组件不做「注册/登录」切换：语义统一为「输入用户名和密码，继续」。
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
        maxLength={32}
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
