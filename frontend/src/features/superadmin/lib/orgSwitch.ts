import type { OrganizationRecord } from '../../../shared/api/types';

/**
 * 机构开关变更确认流逻辑（FR-ORG-004/005，变更审计由后端 hooks 写入，见 security-privacy §8.1）。
 *
 * 两个机构级开关均为高风险配置：
 * - require_activity_approval（活动发布需平台审核）：关闭后该机构活动将直接发布，绕过平台审核；
 * - allow_sensitive_export（允许机构管理员敏感导出）：开启后机构管理员可导出姓名/手机号等
 *   直接身份信息（FR-EXP-003，仍需二次确认与审计）。
 *
 * 前端仅做确认体验：点击开关不立即生效，先展示变更后果说明并要求显式确认；
 * 真正的限制仍在服务端（technical-design §5.5「权限可信层全部在服务端」）。
 */

/** 机构开关字段名（与 organizations 集合字段一致）。 */
export type OrgSwitchKey = 'require_activity_approval' | 'allow_sensitive_export';

export const ORG_SWITCH_LABELS: Record<OrgSwitchKey, string> = {
  require_activity_approval: '活动发布需平台审核',
  allow_sensitive_export: '允许机构管理员敏感导出',
};

/** 单个开关的待确认变更。 */
export interface OrgSwitchChange {
  key: OrgSwitchKey;
  from: boolean;
  to: boolean;
}

/**
 * 生成某次开关变更的后果说明文案（确认框中展示）。
 * 文案口径来自 FR-ORG-004/005 与 FR-EXP-003 的验收要点。
 */
export function describeOrgSwitchChange(change: OrgSwitchChange): string {
  const { key, to } = change;
  if (key === 'require_activity_approval') {
    return to
      ? '开启后：该机构新发布的活动必须先经平台审核通过，才会对外公开。'
      : '关闭后：该机构活动可直接发布，不再经过平台审核。请确认该机构已具备自行审核能力。';
  }
  return to
    ? '开启后：该机构管理员可执行敏感导出，导出文件将包含姓名、手机号等直接身份信息（仍需逐次二次确认并记录审计）。'
    : '关闭后：该机构管理员将不能导出任何个人信息字段，仅超级管理员可执行敏感导出。';
}

/**
 * 是否为需要「显著警告」的变更。
 * 敏感导出开关开启直接影响个人信息保护面（security-privacy §4），确认框需显著警示样式；
 * 其余变更为普通确认。
 */
export function isHighRiskOrgSwitchChange(change: OrgSwitchChange): boolean {
  return change.key === 'allow_sensitive_export' && change.to === true;
}

/** 从机构记录提取当前开关值。 */
export function currentOrgSwitches(
  org: Pick<OrganizationRecord, 'require_activity_approval' | 'allow_sensitive_export'>,
): Record<OrgSwitchKey, boolean> {
  return {
    require_activity_approval: org.require_activity_approval,
    allow_sensitive_export: org.allow_sensitive_export,
  };
}
