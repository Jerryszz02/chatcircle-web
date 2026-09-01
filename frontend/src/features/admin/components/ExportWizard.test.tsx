import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ExportSelectionV2 } from '../../../shared/api/accountEvent';
import type { ActivityRecord, OrganizationRecord } from '../../../shared/api/types';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({
  adminCollections: vi.fn(),
  previewExportV2: vi.fn(),
  createExportV2: vi.fn(),
}));

import * as apiModule from '../lib/api';
import { ExportWizard } from './ExportWizard';
import { buildExportSelection, initialExportWizardState } from '../lib/exportWizard';

/**
 * 五步导出向导关键路径（PRD §7、api-design §6）。
 * - 分步流转与分步校验（缺活动 / 非法参与者 ID）拦截下一步；
 * - 敏感列客户端提示仅展示，判敏门槛以服务端 preview.requires_sensitive_export 为准；
 * - preview 权限拒绝（sensitive_export_disabled）禁用创建并给出开启指引；
 * - 非敏感/敏感两条创建路径载荷正确（confirm_sensitive 仅在敏感时 true）。
 */

const org = { id: 'org_1', name: '测试机构', allow_sensitive_export: true } as OrganizationRecord;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activities = [{ id: 'act_1', title: '春季倾听会', activity_code: 'CC-01' }] satisfies any[] as ActivityRecord[];

function defaultSelection(): ExportSelectionV2 {
  return buildExportSelection(initialExportWizardState());
}

function renderWizard(onCreated = () => {}) {
  // 步骤 ≥2 拉字段/问卷元数据：测试环境返回空列表即可
  vi.mocked(apiModule.adminCollections).mockReturnValue({
    registrationFieldDefs: { getFullList: () => Promise.resolve([]) },
    activitySurveys: { getFullList: () => Promise.resolve([]) },
    surveyQuestions: { getFullList: () => Promise.resolve([]) },
  } as unknown as ReturnType<typeof apiModule.adminCollections>);

  const previewMock = vi.mocked(apiModule.previewExportV2).mockReset();
  previewMock.mockResolvedValue({
    contract_version: '2026-08-28.t0-v1' as never,
    normalized_selection: defaultSelection(),
    estimated_rows: { registrations: 3 },
    requires_sensitive_export: false,
    sensitive_reasons: [],
    permission: { allowed: true },
  });
  vi.mocked(apiModule.createExportV2)
    .mockReset()
    .mockResolvedValue({ contract_version: '2026-08-28.t0-v1' as never, export_job_id: 'job_1' } as never);

  render(<ExportWizard org={org} activities={activities} onCreated={onCreated} />);
}

const nextBtn = () => screen.getByRole('button', { name: '下一步' });
const backBtn = () => screen.getByRole('button', { name: '上一步' });

/** 从默认状态逐步走完到第 5 步（格式）。 */
async function walkToFormatStep() {
  fireEvent.click(nextBtn()); // →2
  expect(await screen.findByText(/预设模板/)).toBeInTheDocument();
  fireEvent.click(nextBtn()); // →3
  await waitFor(() => expect(screen.getByLabelText('指定参与者 ID')).toBeVisible());
  fireEvent.click(nextBtn()); // →4（默认系统列非空，校验通过）
  await screen.findByText('系统列');
  fireEvent.click(nextBtn()); // →5
  expect(screen.getByRole('radio', { name: /XLSX 工作簿/ })).toBeInTheDocument();
}

describe('ExportWizard 五步流转与校验', () => {
  it('单活动范围未选活动时第 1 步被拦截（不进入数据域）', () => {
    renderWizard();
    fireEvent.click(screen.getByRole('radio', { name: '单场活动' }));
    fireEvent.click(nextBtn());
    expect(screen.getByText('请选择要导出的活动')).toBeInTheDocument();
    expect(screen.queryByText(/预设模板/)).not.toBeInTheDocument();
  });

  it('预设按钮：元数据加载完成前禁用（模板加载中占位），完成后恢复可点（review #3900982144）', async () => {
    // defs/surveys/questions 三个列表都拿到才解锁；先让 questions 挂起以验证「未完成」态
    let releaseQuestions: (v: unknown[]) => void;
    const questionsGate = new Promise<unknown[]>((r) => (releaseQuestions = r));
    vi.mocked(apiModule.adminCollections).mockReturnValue({
      registrationFieldDefs: { getFullList: () => Promise.resolve([]) },
      activitySurveys: { getFullList: () => Promise.resolve([]) },
      surveyQuestions: { getFullList: () => questionsGate },
    } as unknown as ReturnType<typeof apiModule.adminCollections>);

    render(<ExportWizard org={org} activities={activities} onCreated={() => {}} />);
    fireEvent.click(nextBtn()); // →2，触发元数据加载

    expect(screen.getByText('模板加载中…')).toBeVisible();
    const presetBtn = () => screen.getByRole('button', { name: '联系名单' });
    expect(presetBtn()).toBeDisabled();

    releaseQuestions!([]); // 加载完成
    await waitFor(() => expect(presetBtn()).toBeEnabled());
    expect(screen.queryByText('模板加载中…')).not.toBeInTheDocument();

    fireEvent.click(presetBtn()); // 应用预设（空元数据下仅填系统列）→ 进入下一步应通过
    fireEvent.click(nextBtn());
    await screen.findByLabelText('指定参与者 ID');
  }, 15_000);

  it('指定参与者含非法 ID 时第 3 步被拦截并列出坏值', async () => {
    renderWizard();
    fireEvent.click(nextBtn()); // →2
    await screen.findByText(/预设模板/);
    fireEvent.click(nextBtn()); // →3
    fireEvent.change(screen.getByLabelText('指定参与者 ID'), { target: { value: 'p1, bad id!' } });
    fireEvent.click(nextBtn());
    // 'p1, bad id!' 按逗号/空白切分为 p1 / bad / id!，仅 id! 非法
    expect(await screen.findByText('参与者 ID 含非法字符：id!')).toBeInTheDocument();
  });

  it('勾选敏感列后展示客户端提示（仅提示，判敏以服务端为准）', async () => {
    renderWizard();
    fireEvent.click(nextBtn()); // →2；预设需元数据，跳过
    await screen.findByText(/预设模板/);
    fireEvent.click(nextBtn()); // →3
    await waitFor(() => expect(screen.getByLabelText('指定参与者 ID')).toBeVisible());
    fireEvent.click(nextBtn()); // →4
    fireEvent.click(screen.getByLabelText('完整手机号（敏感）'));
    expect(await screen.findByText(/已选内容包含敏感项/)).toBeInTheDocument();
  });
});

describe('ExportWizard preview 与创建', () => {
  it('非敏感路径：preview 后直接可创建，confirm_sensitive 为 false', async () => {
    renderWizard();
    await walkToFormatStep();
    fireEvent.click(screen.getByRole('button', { name: '生成预览' }));
    expect(await screen.findByText(/预估行数/)).toBeInTheDocument();

    const createBtn = () => screen.getByRole('button', { name: '创建导出任务' });
    expect(createBtn()).toBeEnabled();
    fireEvent.click(createBtn());

    await waitFor(() => expect(apiModule.previewExportV2).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiModule.createExportV2).toHaveBeenCalledTimes(1));
    expect(apiModule.previewExportV2).toHaveBeenCalledWith(defaultSelection());
    const createMock = vi.mocked(apiModule.createExportV2);
    const payload = createMock.mock.calls[0]?.[0] as { confirm_sensitive?: boolean };
    expect(payload.confirm_sensitive ?? false).toBe(false);
    // 任务 ID 包在 <code> 内，文本被拆成多个节点；matcher 首参即 textContent
    expect(
      await screen.findByText((content) => content?.includes('导出任务已创建（任务 ID：') ?? false),
    ).toBeInTheDocument();
  }, 15_000);

  it('敏感路径：预览失效须重新 preview，未勾选二次确认禁用创建，确认后载荷带 confirm_sensitive:true', async () => {
    renderWizard();
    await walkToFormatStep();

    // 回第 4 步勾真实服务端返回的敏感列 → 选择变更导致预览键失配（此时还没生成过预览）
    fireEvent.click(backBtn()); // →4
    await screen.findByText('系统列');
    fireEvent.click(screen.getByLabelText('完整手机号（敏感）'));

    // preview mock 按载荷联动：含 phone_full 时服务端判定敏感
    vi.mocked(apiModule.previewExportV2).mockImplementation(
      async (sel) => ({
        contract_version: '2026-08-28.t0-v1' as never,
        normalized_selection: sel,
        estimated_rows: { registrations: 3 },
        requires_sensitive_export: (sel as ExportSelectionV2).columns.system.includes('phone_full'),
        sensitive_reasons: [
          { source: 'account_column', code: 'phone_full' },
        ],
        permission: { allowed: true },
      }),
    );
    fireEvent.click(nextBtn()); // →5

    fireEvent.click(screen.getByRole('button', { name: '生成预览' }));
    await waitFor(() =>
      screen.findByText(/本次导出包含敏感内容/),
    );
    expect(apiModule.previewExportV2).toHaveBeenCalledWith(
      expect.objectContaining({ columns: expect.objectContaining({ system: expect.arrayContaining(['phone_full']) }) }),
    );

    const createBtn = () => screen.getByRole('button', { name: '创建导出任务' });
    await waitFor(() => expect(createBtn()).toBeDisabled());
    fireEvent.click(screen.getByLabelText(/我已知晓本次导出包含敏感字段/));
    await waitFor(() => expect(createBtn()).toBeEnabled());

    fireEvent.click(createBtn());
    const createMock = vi.mocked(apiModule.createExportV2);
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const payload = createMock.mock.calls[0]?.[0] as { confirm_sensitive?: boolean };
    expect(payload.confirm_sensitive).toBe(true);
  }, 15_000);

  it('preview 权限拒绝（敏感开关未开）：禁用创建并给出开启指引', async () => {
    renderWizard();
    vi.mocked(apiModule.previewExportV2)
      .mockReset()
      .mockResolvedValue({
        contract_version: '2026-08-28.t0-v1' as never,
        normalized_selection: defaultSelection(),
        estimated_rows: {},
        requires_sensitive_export: true,
        sensitive_reasons: [{ source: 'account_column', code: 'phone_full' }],
        permission: { allowed: false, code: 'sensitive_export_disabled' },
      });
    await walkToFormatStep();
    fireEvent.click(screen.getByRole('button', { name: '生成预览' }));

    expect(await screen.findByText(/本机构未开启敏感导出开关/)).toBeInTheDocument();
    const createBtn = () => screen.getByRole('button', { name: '创建导出任务' });
    await waitFor(() => expect(createBtn()).toBeDisabled());
    fireEvent.click(createBtn());
    expect(apiModule.createExportV2).not.toHaveBeenCalled();
  }, 15_000);

  it('preview 网络失败：展示错误文案且不进入创建态', async () => {
    renderWizard();
    vi.mocked(apiModule.previewExportV2)
      .mockReset()
      .mockRejectedValue(new Error('无法连接服务器，请检查网络后重试'));
    await walkToFormatStep();
    fireEvent.click(screen.getByRole('button', { name: '生成预览' }));

    expect(await screen.findByText(/无法连接服务器/)).toBeInTheDocument();
    expect(apiModule.createExportV2).not.toHaveBeenCalled();
  }, 15_000);
});
