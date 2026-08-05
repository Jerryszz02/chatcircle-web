import { useState } from 'react';
import type { OrganizationRecord } from '../../../shared/api/types';
import { Button } from '../../../shared/ui';
import {
  ORG_SWITCH_LABELS,
  describeOrgSwitchChange,
  isHighRiskOrgSwitchChange,
  type OrgSwitchChange,
  type OrgSwitchKey,
} from '../lib/orgSwitch';

/**
 * 机构开关编辑器（FR-ORG-004/005）。
 *
 * 确认流：点击开关不立即生效，先进入「待确认」态并展示变更后果说明；
 * 敏感导出开启为高风险变更，以显著警示样式展示（isHighRiskOrgSwitchChange）。
 * 显式确认后才回调 onSave 提交服务端；变更审计由后端 hooks 写入。
 */

export interface OrgSwitchesEditorProps {
  org: OrganizationRecord;
  /** 提交开关变更（新值）。 */
  onSave: (next: Record<OrgSwitchKey, boolean>) => Promise<void>;
  /** 外部提交中状态（禁用交互）。 */
  saving?: boolean;
}

export function OrgSwitchesEditor({ org, onSave, saving = false }: OrgSwitchesEditorProps) {
  // 待确认变更；null 表示无暂存变更（开关展示当前生效值）
  const [pending, setPending] = useState<OrgSwitchChange | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current: Record<OrgSwitchKey, boolean> = {
    require_activity_approval: org.require_activity_approval,
    allow_sensitive_export: org.allow_sensitive_export,
  };

  const stageChange = (key: OrgSwitchKey) => {
    setError(null);
    setPending({ key, from: current[key], to: !current[key] });
  };

  const confirm = async () => {
    if (!pending) return;
    setError(null);
    try {
      await onSave({ ...current, [pending.key]: pending.to });
      setPending(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败，请稍后重试');
    }
  };

  const valueOf = (key: OrgSwitchKey) => (pending?.key === key ? pending.to : current[key]);

  return (
    <div>
      {(Object.keys(ORG_SWITCH_LABELS) as OrgSwitchKey[]).map((key) => (
        <div key={key} className="cc-field">
          <label className="cc-label">
            <input
              type="checkbox"
              checked={valueOf(key)}
              disabled={saving}
              onChange={() => stageChange(key)}
            />{' '}
            {ORG_SWITCH_LABELS[key]}
          </label>
        </div>
      ))}

      {pending ? (
        <div
          className={`sa-confirm-warning${isHighRiskOrgSwitchChange(pending) ? ' sa-confirm-warning-high' : ''}`}
          role={isHighRiskOrgSwitchChange(pending) ? 'alert' : 'note'}
        >
          <p>{describeOrgSwitchChange(pending)}</p>
          <div className="sa-actions">
            <Button onClick={() => void confirm()} loading={saving}>
              确认变更
            </Button>
            <Button variant="secondary" disabled={saving} onClick={() => setPending(null)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
