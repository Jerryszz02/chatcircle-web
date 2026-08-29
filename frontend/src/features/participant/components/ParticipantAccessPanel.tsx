import { useState } from 'react';
import { participantAuth } from '../../../shared/auth';
import type { ParticipantAccountRecord } from '../../../shared/api/types';
import { Button } from '../../../shared/ui';
import { ParticipantAuthForm } from './ParticipantAuthForm';
import { PhoneAuthForm } from './PhoneAuthForm';
import { PhoneBindingForm } from './PhoneBindingForm';

/** 手机号主入口；仅为存量用户名账号保留迁移入口。 */
export function ParticipantAccessPanel({ onSuccess }: { onSuccess: () => void }) {
  const [legacyMode, setLegacyMode] = useState(false);
  const [legacyAuthenticated, setLegacyAuthenticated] = useState(false);
  const [mergeRequired, setMergeRequired] = useState(false);

  if (!legacyMode) {
    return (
      <>
        <PhoneAuthForm onSuccess={onSuccess} />
        <div className="cc-auth-switch">
          <Button type="button" variant="secondary" block onClick={() => setLegacyMode(true)}>
            使用原用户名账号迁移
          </Button>
        </div>
      </>
    );
  }

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
        <Button type="button" variant="secondary" block onClick={() => setLegacyMode(false)}>
          返回手机号登录
        </Button>
      </div>
    </>
  );
}
