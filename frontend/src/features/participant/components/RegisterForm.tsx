import { useState } from 'react';
import type { FormEvent } from 'react';
import { normalizeApiError } from '../../../shared/api/http';
import { saveParticipantPhoneAuth } from '../../../shared/auth';
import { Button, Input } from '../../../shared/ui';
import { registerParticipant, requestParticipantPhoneCode } from '../api';
import {
  normalizeMainlandPhone,
  PARTICIPANT_PHONE_PRIVACY_NOTICE,
  PARTICIPANT_PRIVACY_NOTICE_VERSION,
  validateMainlandPhone,
  validatePhoneCode,
} from '../lib/phone';
import {
  normalizeUsername,
  USERNAME_MAX,
  USERNAME_PRIVACY_NOTICE,
  USERNAME_RULE_HINT,
  validatePassword,
  validateUsername,
} from '../lib/username';

/**
 * 注册（T2）：用户名 + 密码 + 手机号（短信验证码验证）。
 * 两步：填写账号信息并请求验证码（purpose=register，服务端存隐私版本号）→
 * 输入验证码提交注册，成功即登录。用户名隐私提示为 PRD §11.1 要求。
 */
export function RegisterForm({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [challengeId, setChallengeId] = useState('');
  const [usernameError, setUsernameError] = useState<string | undefined>();
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [confirmError, setConfirmError] = useState<string | undefined>();
  const [phoneError, setPhoneError] = useState<string | undefined>();
  const [codeError, setCodeError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [requesting, setRequesting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  /** 校验账号信息（请求验证码与提交注册前共用）。 */
  function validateAccountFields(): boolean {
    const uErr = validateUsername(username);
    const pErr = validatePassword(password);
    const cErr = confirmPassword !== password ? '两次输入的密码不一致' : null;
    const phErr = validateMainlandPhone(phone);
    setUsernameError(uErr ?? undefined);
    setPasswordError(pErr ?? undefined);
    setConfirmError(cErr ?? undefined);
    setPhoneError(phErr ?? undefined);
    setFormError(undefined);
    return !(uErr || pErr || cErr || phErr);
  }

  async function requestCode() {
    if (!validateAccountFields()) return;
    if (!privacyAccepted) {
      setFormError('请阅读并同意隐私说明后继续');
      return;
    }
    setRequesting(true);
    try {
      const response = await requestParticipantPhoneCode({
        phone: normalizeMainlandPhone(phone)!,
        purpose: 'register',
        privacy_notice_version: PARTICIPANT_PRIVACY_NOTICE_VERSION,
      });
      setChallengeId(response.challenge_id);
    } catch (err) {
      setFormError(normalizeApiError(err).message);
    } finally {
      setRequesting(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!challengeId) return;
    if (!validateAccountFields()) return;
    const cErr = validatePhoneCode(code);
    setCodeError(cErr ?? undefined);
    if (cErr) return;
    setSubmitting(true);
    try {
      const response = await registerParticipant({
        username: normalizeUsername(username),
        password,
        phone: normalizeMainlandPhone(phone)!,
        challenge_id: challengeId,
        code: code.trim(),
        privacy_notice_version: PARTICIPANT_PRIVACY_NOTICE_VERSION,
      });
      saveParticipantPhoneAuth(response);
      onSuccess();
    } catch (err) {
      setFormError(normalizeApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <p className="cc-notice cc-notice-privacy">{USERNAME_PRIVACY_NOTICE}</p>
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
        disabled={Boolean(challengeId)}
      />
      <Input
        label="密码"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint="至少 8 位；忘记密码可用绑定手机号找回"
        error={passwordError}
        required
        autoComplete="new-password"
        disabled={Boolean(challengeId)}
      />
      <Input
        label="确认密码"
        type="password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        error={confirmError}
        required
        autoComplete="new-password"
        disabled={Boolean(challengeId)}
      />
      <Input
        label="手机号"
        type="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        hint="用于验证码登录与找回密码；目前仅支持中国大陆 +86 手机号"
        error={phoneError}
        required
        inputMode="tel"
        autoComplete="tel"
        disabled={Boolean(challengeId)}
      />
      {challengeId ? (
        <Input
          label="验证码"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
          hint="验证码 5 分钟内有效，使用后立即失效"
          error={codeError}
          required
          inputMode="numeric"
          autoComplete="one-time-code"
        />
      ) : (
        <label className="cc-consent">
          <input
            type="checkbox"
            checked={privacyAccepted}
            onChange={(e) => setPrivacyAccepted(e.target.checked)}
          />
          <span>{PARTICIPANT_PHONE_PRIVACY_NOTICE}</span>
        </label>
      )}
      {formError ? (
        <p className="cc-error" role="alert">
          {formError}
        </p>
      ) : null}
      {challengeId ? (
        <Button type="submit" block loading={submitting}>
          注册并登录
        </Button>
      ) : (
        <Button type="button" block loading={requesting} onClick={requestCode}>
          获取验证码
        </Button>
      )}
    </form>
  );
}
