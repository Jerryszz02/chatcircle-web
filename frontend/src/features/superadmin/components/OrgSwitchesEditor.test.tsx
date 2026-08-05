import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OrganizationRecord } from '../../../shared/api/types';
import { OrgSwitchesEditor } from './OrgSwitchesEditor';

function makeOrg(overrides: Partial<OrganizationRecord> = {}): OrganizationRecord {
  return {
    id: 'org1',
    created: '2026-08-01 00:00:00.000Z',
    updated: '2026-08-01 00:00:00.000Z',
    name: '示例机构',
    status: 'active',
    require_activity_approval: true,
    allow_sensitive_export: false,
    ...overrides,
  };
}

describe('机构开关确认流（OrgSwitchesEditor）', () => {
  it('初始渲染两个开关并显示当前生效值', () => {
    render(<OrgSwitchesEditor org={makeOrg()} onSave={vi.fn()} />);
    const approval = screen.getByRole('checkbox', { name: /活动发布需平台审核/ });
    const sensitive = screen.getByRole('checkbox', { name: /允许机构管理员敏感导出/ });
    expect(approval).toBeChecked();
    expect(sensitive).not.toBeChecked();
  });

  it('点击开关不立即生效：进入待确认态并展示后果说明', () => {
    const onSave = vi.fn();
    render(<OrgSwitchesEditor org={makeOrg()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /允许机构管理员敏感导出/ }));
    expect(onSave).not.toHaveBeenCalled();
    // 敏感导出开启为高风险：显著警示（role=alert）+ 直接身份信息提示
    expect(screen.getByRole('alert')).toHaveTextContent('直接身份信息');
    // 暂存态：勾选框显示变更后的值
    expect(screen.getByRole('checkbox', { name: /允许机构管理员敏感导出/ })).toBeChecked();
  });

  it('取消：恢复原值且不提交易', () => {
    const onSave = vi.fn();
    render(<OrgSwitchesEditor org={makeOrg()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /允许机构管理员敏感导出/ }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: /允许机构管理员敏感导出/ })).not.toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('确认变更：以新值回调 onSave', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<OrgSwitchesEditor org={makeOrg()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /允许机构管理员敏感导出/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认变更' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      require_activity_approval: true,
      allow_sensitive_export: true,
    });
  });

  it('审核开关关闭：展示直发风险提示（普通确认样式）', () => {
    render(<OrgSwitchesEditor org={makeOrg()} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /活动发布需平台审核/ }));
    expect(screen.getByRole('note')).toHaveTextContent('直接发布');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('onSave 失败：展示错误且保留待确认态', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('保存失败'));
    render(<OrgSwitchesEditor org={makeOrg()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /允许机构管理员敏感导出/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认变更' }));
    await waitFor(() => expect(screen.getByText('保存失败')).toBeInTheDocument());
    // 待确认态保留，用户可重试或取消
    expect(screen.getByRole('button', { name: '确认变更' })).toBeInTheDocument();
  });
});
