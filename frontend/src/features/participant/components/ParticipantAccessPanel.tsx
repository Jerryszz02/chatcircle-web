import { useState } from 'react';
import { participantAuth } from '../../../shared/auth';
import type { ParticipantAccountRecord } from '../../../shared/api/types';
import { Button } from '../../../shared/ui';
import { AccountPasswordForm } from './AccountPasswordForm';
import { ParticipantAuthForm } from './ParticipantAuthForm';
import { PhoneAuthForm } from './PhoneAuthForm';
import { PhoneBindingForm } from './PhoneBindingForm';
import { RegisterForm } from './RegisterForm';
import { ResetPasswordForm } from './ResetPasswordForm';

type AccessView = 'password' | 'code' | 'register' | 'reset' | 'legacy';

/**
 * 参与者接入面板（T2）：账号密码（用户名/手机号+密码）为主登录方式；
 * 手机验证码登录为备选入口；注册（用户名+密码+手机号验证）与找回密码
 * （手机号验证码重置）在此闭环；存量纯用户名账号迁移入口保留在登录页底部。
 */
export function ParticipantAccessPanel({ onSuccess }: { onSuccess: () => void }) {
  const [view, setView] = useState<AccessView>('password');
  const [legacyAuthenticated, setLegacyAuthenticated] = useState(false);
  const [mergeRequired, setMergeRequired] = useState(false);

  if (view === 'register') {
    return (
      <>
        <RegisterForm onSuccess={onSuccess} />
        <div className="cc-auth-switch">
          <Button type="button" variant="secondary" block onClick={() => setView('password')}>
            已有账号，返回登录
          </Button>
        </div>
      </>
    );
  }

  if (view === 'reset') {
    return (
      <>
        <ResetPasswordForm onSuccess={onSuccess} />
        <div className="cc-auth-switch">
          <Button type="button" variant="secondary" block onClick={() => setView('password')}>
            返回登录
          </Button>
        </div>
      </>
    );
  }

  if (view === 'code') {
    return (
      <>
        <PhoneAuthForm submitLabel="登录" onSuccess={onSuccess} />
        <div className="cc-auth-switch">
          <Button type="button" variant="secondary" block onClick={() => setView('password')}>
            使用账号密码登录
          </Button>
        </div>
      </>
    );
  }

  if (view === 'legacy') {
    if (legacyAuthenticated) {
      if (mergeRequired) {
        return (
          <p className="cc-notice">
            该账号存在手机号冲突，无法自动合并。请联系人工支持，并保留当前账号的登录信息。
          </p>
        );
      }
      return <PhoneBindingForm onSuccess={onSuccess} />;
    }
    return (
      <>
        <ParticipantAuthForm
          submitLabel="登录原账号"
          intro="仅供已有用户名账号迁移。登录后绑定手机号，原账号 ID 和历史记录保持不变。"
          onSuccess={() => {
            const record = participantAuth.record as ParticipantAccountRecord | null;
            if (record?.phone_migration_status === 'phone_bound') onSuccess();
            else {
              setMergeRequired(record?.phone_migration_status === 'merge_required');
              setLegacyAuthenticated(true);
            }
          }}
        />
        <div className="cc-auth-switch">
          <Button type="button" variant="secondary" block onClick={() => setView('password')}>
            返回登录
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <AccountPasswordForm onSuccess={onSuccess} />
      <div className="cc-auth-switch">
        <button type="button" className="cc-link-button" onClick={() => setView('code')}>
          手机验证码登录
        </button>
        <button type="button" className="cc-link-button" onClick={() => setView('register')}>
          注册账号
        </button>
        <button type="button" className="cc-link-button" onClick={() => setView('reset')}>
          忘记密码
        </button>
      </div>
      <div className="cc-auth-switch">
        <button type="button" className="cc-link-button" onClick={() => setView('legacy')}>
          使用原用户名账号迁移
        </button>
      </div>
    </>
  );
}
