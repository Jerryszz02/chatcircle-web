import { useState } from 'react';
import type { FormEvent } from 'react';
import { normalizeApiError } from '../../../shared/api/http';
import { saveParticipantPhoneAuth } from '../../../shared/auth';
import { Button, Input } from '../../../shared/ui';
import { requestParticipantPhoneCode, resetParticipantPassword } from '../api';
import { normalizeMainlandPhone, validateMainlandPhone, validatePhoneCode } from '../lib/phone';
import { validatePassword } from '../lib/username';

/**
 * 找回密码（T2）：手机号 + 短信验证码 → 设置新密码，成功即登录。
 * 两步：请求验证码（purpose=reset_password）→ 输入验证码与新密码提交。
 */
export function ResetPasswordForm({ onSuccess }: { onSuccess: () => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [phoneError, setPhoneError] = useState<string | undefined>();
  const [codeError, setCodeError] = useState<string | undefined>();
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [confirmError, setConfirmError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [requesting, setRequesting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function requestCode() {
    const error = validateMainlandPhone(phone);
    setPhoneError(error ?? undefined);
    setFormError(undefined);
    if (error) return;
    setRequesting(true);
    try {
      const response = await requestParticipantPhoneCode({
        phone: normalizeMainlandPhone(phone)!,
        purpose: 'reset_password',
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
    const cErr = validatePhoneCode(code);
    const pErr = validatePassword(newPassword);
    const cfErr = confirmPassword !== newPassword ? '两次输入的密码不一致' : null;
    setCodeError(cErr ?? undefined);
    setPasswordError(pErr ?? undefined);
    setConfirmError(cfErr ?? undefined);
    setFormError(undefined);
    if (cErr || pErr || cfErr) return;
    setSubmitting(true);
    try {
      const response = await resetParticipantPassword({
        phone: normalizeMainlandPhone(phone)!,
        challenge_id: challengeId,
        code: code.trim(),
        new_password: newPassword,
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
      <p className="cc-notice">输入注册时使用的手机号，验证通过后即可设置新密码。</p>
      <Input
        label="手机号"
        type="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        hint="目前仅支持中国大陆 +86 手机号"
        error={phoneError}
        required
        inputMode="tel"
        autoComplete="tel"
        disabled={Boolean(challengeId)}
      />
      {challengeId ? (
        <>
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
          <Input
            label="新密码"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            hint="至少 8 位"
            error={passwordError}
            required
            autoComplete="new-password"
          />
          <Input
            label="确认新密码"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            error={confirmError}
            required
            autoComplete="new-password"
          />
        </>
      ) : null}
      {formError ? (
        <p className="cc-error" role="alert">
          {formError}
        </p>
      ) : null}
      {challengeId ? (
        <Button type="submit" block loading={submitting}>
          重置密码并登录
        </Button>
      ) : (
        <Button type="button" block loading={requesting} onClick={requestCode}>
          获取验证码
        </Button>
      )}
    </form>
  );
}
