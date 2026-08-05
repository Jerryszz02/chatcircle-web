import { describe, expect, it } from 'vitest';
import {
  ORG_SWITCH_LABELS,
  currentOrgSwitches,
  describeOrgSwitchChange,
  isHighRiskOrgSwitchChange,
} from './orgSwitch';

describe('机构开关变更确认流（FR-ORG-004/005）', () => {
  it('审核开关开启：提示之后活动须平台审核', () => {
    const text = describeOrgSwitchChange({ key: 'require_activity_approval', from: false, to: true });
    expect(text).toContain('平台审核');
  });

  it('审核开关关闭：提示活动将直发、绕过平台审核', () => {
    const text = describeOrgSwitchChange({ key: 'require_activity_approval', from: true, to: false });
    expect(text).toContain('直接发布');
    expect(text).toContain('不再经过平台审核');
  });

  it('敏感导出开关开启：提示将包含直接身份信息且仍需二次确认与审计', () => {
    const text = describeOrgSwitchChange({ key: 'allow_sensitive_export', from: false, to: true });
    expect(text).toContain('直接身份信息');
    expect(text).toContain('审计');
  });

  it('敏感导出开关关闭：提示机构管理员不能再导出个人信息', () => {
    const text = describeOrgSwitchChange({ key: 'allow_sensitive_export', from: true, to: false });
    expect(text).toContain('不能导出任何个人信息字段');
  });

  it('高风险判定：仅「敏感导出开启」需要显著警示样式', () => {
    expect(isHighRiskOrgSwitchChange({ key: 'allow_sensitive_export', from: false, to: true })).toBe(true);
    expect(isHighRiskOrgSwitchChange({ key: 'allow_sensitive_export', from: true, to: false })).toBe(false);
    expect(isHighRiskOrgSwitchChange({ key: 'require_activity_approval', from: false, to: true })).toBe(false);
    expect(isHighRiskOrgSwitchChange({ key: 'require_activity_approval', from: true, to: false })).toBe(false);
  });

  it('两个开关均有中文标签，currentOrgSwitches 提取当前值', () => {
    expect(ORG_SWITCH_LABELS.require_activity_approval).toBe('活动发布需平台审核');
    expect(ORG_SWITCH_LABELS.allow_sensitive_export).toBe('允许机构管理员敏感导出');
    expect(
      currentOrgSwitches({ require_activity_approval: true, allow_sensitive_export: false }),
    ).toEqual({ require_activity_approval: true, allow_sensitive_export: false });
  });
});
