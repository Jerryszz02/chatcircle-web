import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityRecord, RegistrationFieldDefRecord, SurveyTemplateRecord } from '../../../shared/api/types';

vi.mock('../lib/api', () => ({
  adminCollections: vi.fn(),
  createActivitySurvey: vi.fn(),
  duplicateActivity: vi.fn(),
  runActivityAction: vi.fn(),
}));

import * as apiModule from '../lib/api';
import { ActivityForm } from './ActivityForm';
import { ActivityCreateWizard } from './ActivityCreateWizard';
import { SurveyPanel } from '../pages/detail/SurveyPanel';

const fieldDefs = [
  {
    id: 'field_name', field_code: 'FULL_NAME', label: '姓名', field_type: 'text', source_type: 'standard',
    is_sensitive: false, required_default: true, role_scope: 'both', status: 'active',
  },
  {
    id: 'field_old', field_code: 'OLD_CHOICE', label: '旧报名字段', field_type: 'text', source_type: 'standard',
    is_sensitive: false, required_default: false, role_scope: 'speaker', status: 'active',
    config_json: { default_disabled: true },
  },
] as RegistrationFieldDefRecord[];

const templates = [
  { id: 'reg', name: '倾诉者报名表', template_code: 'CHATTER_REG', kind: 'registration', role_scope: 'speaker', current_version_id: 'v_reg' },
  { id: 'post', name: '聆听者后测', template_code: 'LISTENER_POST', kind: 'survey', role_scope: 'listener', current_version_id: 'v_post' },
  { id: 'generic', name: '通用问卷', template_code: 'GENERIC', kind: 'survey', role_scope: '', current_version_id: 'v_generic' },
] as SurveyTemplateRecord[];

const activity = {
  id: 'activity_1', activity_code: 'CC_2026_01', title: '测试活动', status: 'draft', capacity_total: 2,
  start_time: '2026-10-01 10:00:00.000Z', end_time: '2026-10-01 11:00:00.000Z',
  form_config_json: { fields: [{ field_def_id: 'field_name', enabled: true, required: true }] },
} as ActivityRecord;

function setupCollections() {
  const create = vi.fn().mockResolvedValue(activity);
  const update = vi.fn().mockResolvedValue(activity);
  vi.mocked(apiModule.adminCollections).mockReturnValue({
    activities: { getFullList: () => Promise.resolve([]), create, update },
    registrationFieldDefs: { getFullList: () => Promise.resolve(fieldDefs) },
    surveyTemplates: { getFullList: () => Promise.resolve(templates) },
    activitySurveys: { getFullList: () => Promise.resolve([]) },
    organizations: { getOne: () => Promise.resolve(null) },
  } as unknown as ReturnType<typeof apiModule.adminCollections>);
  vi.mocked(apiModule.createActivitySurvey).mockResolvedValue({} as never);
  return { create, update };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('活动表单的报名字段默认配置', () => {
  it('编辑活动时，新出现且 default_disabled 的旧字段保持关闭并写入配置', async () => {
    const { update } = setupCollections();
    render(<ActivityForm mode="edit" initial={activity} approvedCounts={{ total: 0, speaker: 0, listener: 0 }} onSaved={vi.fn()} />);
    const row = (await screen.findByText('旧报名字段')).closest('.admin-field-row');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole('checkbox', { name: '启用' })).not.toBeChecked();
    expect(within(row as HTMLElement).getByRole('checkbox', { name: '必填' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[1]).toMatchObject({
      form_config_json: { fields: expect.arrayContaining([{ field_def_id: 'field_old', enabled: false, required: false }]) },
    });
  });
});

describe('创建向导的后测模板选择', () => {
  it('排除报名模板、固定角色专属模板与活动后阶段，并保留默认关闭字段', async () => {
    const { create } = setupCollections();
    render(<MemoryRouter><ActivityCreateWizard /></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByRole('textbox', { name: '活动标题' }), { target: { value: '测试活动' } });
    fireEvent.change(screen.getByRole('textbox', { name: '活动代码' }), { target: { value: 'CC_2026_01' } });
    fireEvent.change(screen.getByLabelText(/开始时间/), { target: { value: '2026-10-01T10:00' } });
    fireEvent.change(screen.getByLabelText(/结束时间/), { target: { value: '2026-10-01T11:00' } });
    fireEvent.change(screen.getByLabelText(/总名额/), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    const row = (await screen.findByText('旧报名字段')).closest('.admin-field-row');
    expect(within(row as HTMLElement).getByRole('checkbox', { name: '启用' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(await screen.findByText('聆听者后测')).toBeInTheDocument();
    expect(screen.queryByText('倾诉者报名表')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /聆听者后测/ }));
    expect(screen.getByRole('combobox', { name: '聆听者后测 适用角色' })).toHaveValue('listener');
    expect(screen.getByRole('combobox', { name: '聆听者后测 适用角色' })).toBeDisabled();
    expect(screen.getByText('问卷阶段：活动后')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '聆听者后测 问卷阶段' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /通用问卷/ }));
    expect(screen.getByRole('combobox', { name: '通用问卷 适用角色' })).toHaveValue('both');
    expect(screen.getByRole('combobox', { name: '通用问卷 适用角色' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: '通用问卷 问卷阶段' })).toHaveValue('onsite');
    expect(screen.getByRole('combobox', { name: '通用问卷 问卷阶段' })).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /通用问卷/ }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      form_config_json: { fields: expect.arrayContaining([{ field_def_id: 'field_old', enabled: false, required: false }]) },
    });
    await waitFor(() => expect(apiModule.createActivitySurvey).toHaveBeenCalledTimes(1));
    expect(apiModule.createActivitySurvey).toHaveBeenCalledWith('activity_1', expect.objectContaining({
      template_version_id: 'v_post', role_scope: 'listener', phase: 'after',
    }));
  });
});

describe('活动详情的问卷模板选择', () => {
  it('旧模板 role_scope 为空时按 both 创建，角色专属后测固定 after', async () => {
    setupCollections();
    render(<SurveyPanel activity={activity} />);
    fireEvent.click(await screen.findByRole('button', { name: '从模板创建问卷' }));
    expect(screen.queryByRole('option', { name: /倾诉者报名表/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/问卷模板/), { target: { value: 'generic' } });
    expect(screen.getByRole('combobox', { name: '适用角色' })).toHaveValue('both');
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(apiModule.createActivitySurvey).toHaveBeenCalledTimes(1));
    expect(apiModule.createActivitySurvey).toHaveBeenLastCalledWith('activity_1', expect.objectContaining({
      template_version_id: 'v_generic', role_scope: 'both',
    }));

    fireEvent.click(screen.getByRole('button', { name: '从模板创建问卷' }));
    fireEvent.change(screen.getByLabelText(/问卷模板/), { target: { value: 'post' } });
    expect(screen.getByRole('combobox', { name: '适用角色' })).toHaveValue('listener');
    expect(screen.getByRole('combobox', { name: '适用角色' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(apiModule.createActivitySurvey).toHaveBeenCalledTimes(2));
    expect(apiModule.createActivitySurvey).toHaveBeenLastCalledWith('activity_1', expect.objectContaining({
      template_version_id: 'v_post', role_scope: 'listener', phase: 'after',
    }));
  });
});
