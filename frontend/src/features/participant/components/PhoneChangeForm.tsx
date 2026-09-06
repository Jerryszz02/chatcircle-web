import { useState } from 'react';
import type { FormEvent } from 'react';
import { normalizeApiError } from '../../../shared/api/http';
import { updateParticipantPhoneSession } from '../../../shared/auth';
import { Button, Input } from '../../../shared/ui';
import { changeParticipantPhone, requestParticipantPhoneCode } from '../api';
import { normalizeMainlandPhone, validateMainlandPhone, validatePhoneCode } from '../lib/phone';

/** 已绑定账号通过旧手机号和新手机号各一次验证码完成原子换绑。 */
export function PhoneChangeForm({ onSuccess }: { onSuccess: () => void }) {
  const [oldPhone, setOldPhone] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [oldCode, setOldCode] = useState('');
  const [newCode, setNewCode] = useState('');
  const [oldChallengeId, setOldChallengeId] = useState('');
  const [newChallengeId, setNewChallengeId] = useState('');
  const [formError, setFormError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function requestCode(phone: string, role: 'old' | 'new') {
    const error = validateMainlandPhone(phone);
    if (error) {
      setFormError(`${role === 'old' ? '当前' : '新'}手机号：${error}`);
      return;
    }
    setFormError(undefined);
    setLoading(true);
    try {
      const response = await requestParticipantPhoneCode({
        phone: normalizeMainlandPhone(phone)!,
        purpose: 'change_phone',
      });
      if (role === 'old') setOldChallengeId(response.challenge_id);
      else setNewChallengeId(response.challenge_id);
    } catch (err) {
      setFormError(normalizeApiError(err).message);
    } finally {
      setLoading(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const normalizedOld = normalizeMainlandPhone(oldPhone);
    const normalizedNew = normalizeMainlandPhone(newPhone);
    const error =
      validateMainlandPhone(oldPhone) ??
      validateMainlandPhone(newPhone) ??
      validatePhoneCode(oldCode) ??
      validatePhoneCode(newCode);
    if (error || !oldChallengeId || !newChallengeId) {
      setFormError(error ?? '请先分别获取当前手机号和新手机号的验证码');
      return;
    }
    if (normalizedOld === normalizedNew) {
      setFormError('新手机号不能与当前手机号相同');
      return;
    }
    setFormError(undefined);
    setLoading(true);
    try {
      const response = await changeParticipantPhone({
        phone: normalizedNew!,
        challenge_id: newChallengeId,
        code: newCode.trim(),
        verification_method: 'old_phone',
        old_phone_challenge_id: oldChallengeId,
        old_phone_code: oldCode.trim(),
      });
      updateParticipantPhoneSession(response);
      onSuccess();
    } catch (err) {
      setFormError(normalizeApiError(err).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <p className="cc-notice">为保护账号安全，需要同时验证当前手机号和新手机号。</p>
      <Input
        label="当前完整手机号"
        type="tel"
        value={oldPhone}
        onChange={(e) => setOldPhone(e.target.value)}
        disabled={Boolean(oldChallengeId)}
        autoComplete="tel"
        inputMode="tel"
        required
      />
      {oldChallengeId ? (
        <Input
          label="当前手机号验证码"
          value={oldCode}
          onChange={(e) => setOldCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
          autoComplete="one-time-code"
          inputMode="numeric"
          required
        />
      ) : (
        <Button type="button" variant="secondary" block loading={loading} onClick={() => requestCode(oldPhone, 'old')}>
          获取当前手机号验证码
        </Button>
      )}
      <Input
        label="新手机号"
        type="tel"
        value={newPhone}
        onChange={(e) => setNewPhone(e.target.value)}
        disabled={Boolean(newChallengeId)}
        autoComplete="tel"
        inputMode="tel"
        required
      />
      {newChallengeId ? (
        <Input
          label="新手机号验证码"
          value={newCode}
          onChange={(e) => setNewCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
          autoComplete="one-time-code"
          inputMode="numeric"
          required
        />
      ) : (
        <Button type="button" variant="secondary" block loading={loading} onClick={() => requestCode(newPhone, 'new')}>
          获取新手机号验证码
        </Button>
      )}
      {formError ? <p className="cc-error" role="alert">{formError}</p> : null}
      <Button type="submit" block loading={loading}>
        确认换绑
      </Button>
    <p className="cc-hint">个人信息用途与保存期限见 <a href="/privacy" target="_blank" rel="noopener noreferrer">隐私政策</a>。必要活动通知不代表营销同意。</p>
    </form>
  );
}
