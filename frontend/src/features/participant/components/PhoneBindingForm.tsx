import { useState } from 'react';
import type { FormEvent } from 'react';
import { normalizeApiError } from '../../../shared/api/http';
import { updateParticipantPhoneSession } from '../../../shared/auth';
import { Button, Input } from '../../../shared/ui';
import { bindParticipantPhone, requestParticipantPhoneCode } from '../api';
import { normalizeMainlandPhone, validateMainlandPhone, validatePhoneCode } from '../lib/phone';

/** 已登录存量用户名账号绑定手机号；成功后 participant_id 不变。 */
export function PhoneBindingForm({ onSuccess }: { onSuccess: () => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [phoneError, setPhoneError] = useState<string>();
  const [codeError, setCodeError] = useState<string>();
  const [formError, setFormError] = useState<string>();
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
        purpose: 'bind_phone',
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
    const error = validatePhoneCode(code);
    setCodeError(error ?? undefined);
    setFormError(undefined);
    if (!challengeId || error) return;
    setSubmitting(true);
    try {
      const response = await bindParticipantPhone({
        phone: normalizeMainlandPhone(phone)!,
        challenge_id: challengeId,
        code: code.trim(),
      });
      updateParticipantPhoneSession(response);
      onSuccess();
    } catch (err) {
      setFormError(normalizeApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <p className="cc-notice">
        验证手机号后会继续使用当前账号和全部历史记录，不会创建新账号。
      </p>
      <Input
        label="绑定手机号"
        type="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
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
          error={codeError}
          required
          inputMode="numeric"
          autoComplete="one-time-code"
        />
      ) : null}
      {formError ? (
        <p className="cc-error" role="alert">
          {formError}
        </p>
      ) : null}
      {challengeId ? (
        <Button type="submit" block loading={submitting}>
          绑定并继续
        </Button>
      ) : (
        <Button type="button" block loading={requesting} onClick={requestCode}>
          获取验证码
        </Button>
      )}
    <p className="cc-hint">个人信息用途与保存期限见 <a href="/privacy" target="_blank" rel="noopener noreferrer">隐私政策</a>。必要活动通知不代表营销同意。</p>
    </form>
  );
}
