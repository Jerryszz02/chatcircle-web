import { useState } from 'react';
import type { FormEvent } from 'react';
import { normalizeApiError } from '../../../shared/api/http';
import { saveParticipantPhoneAuth } from '../../../shared/auth';
import { Button, Input } from '../../../shared/ui';
import { requestParticipantPhoneCode, verifyParticipantPhoneCode } from '../api';
import {
  normalizeMainlandPhone,
  PARTICIPANT_PHONE_PRIVACY_NOTICE,
  PARTICIPANT_PRIVACY_NOTICE_VERSION,
  validateMainlandPhone,
  validatePhoneCode,
} from '../lib/phone';

/** 手机号验证码登录/注册主入口。新号由服务端幂等建号，旧号直接登录。 */
export function PhoneAuthForm({
  submitLabel = '登录 / 注册',
  onSuccess,
}: {
  submitLabel?: string;
  onSuccess: () => void;
}) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
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
    if (!privacyAccepted) {
      setFormError('请阅读并同意隐私说明后继续');
      return;
    }
    setRequesting(true);
    try {
      const response = await requestParticipantPhoneCode({
        phone: normalizeMainlandPhone(phone)!,
        purpose: 'login_or_register',
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
    if (!challengeId) {
      await requestCode();
      return;
    }
    const error = validatePhoneCode(code);
    setCodeError(error ?? undefined);
    setFormError(undefined);
    if (error) return;
    setSubmitting(true);
    try {
      const response = await verifyParticipantPhoneCode({
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
          <button
            type="button"
            className="cc-link-button"
            onClick={() => {
              setChallengeId('');
              setCode('');
              setCodeError(undefined);
            }}
          >
            更换手机号
          </button>
        </>
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
          {submitLabel}
        </Button>
      ) : (
        <Button type="button" block loading={requesting} onClick={requestCode}>
          获取验证码
        </Button>
      )}
    </form>
  );
}
