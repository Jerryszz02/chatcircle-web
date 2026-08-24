import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RegistrationRecord } from '../../../shared/api/types';
import type { PublicRegistrationField } from '../api';
import { RegistrationForm } from './RegistrationForm';

/**
 * 报名表单组件测试（FR-REG-001/002/004、FR-ACT-007 前端侧）。
 * 覆盖：标准+自定义字段渲染、敏感标记提示、必填校验、角色名额满禁用、
 * 提交载荷（题型值类型与字段 id）、按角色渲染（role_scope）与切换角色清值。
 */

const FIELDS: PublicRegistrationField[] = [
  {
    id: 'fd_name',
    field_code: 'real_name',
    field_type: 'text',
    label: '姓名',
    source_type: 'standard',
    is_sensitive: true,
    required: true,
    role_scope: 'both',
  },
  {
    id: 'fd_age',
    field_code: 'age',
    field_type: 'number',
    label: '年龄',
    source_type: 'standard',
    is_sensitive: false,
    required: false,
    role_scope: 'both',
  },
  {
    id: 'fd_gender',
    field_code: 'gender',
    field_type: 'single_choice',
    label: '性别',
    source_type: 'custom',
    is_sensitive: false,
    required: true,
    role_scope: 'both',
    options_json: [
      { value: 'f', label: '女' },
      { value: 'm', label: '男' },
    ],
  },
  {
    id: 'fd_topics',
    field_code: 'topics',
    field_type: 'multi_choice',
    label: '关注话题',
    source_type: 'custom',
    is_sensitive: false,
    required: false,
    role_scope: 'both',
    options_json: ['学业', '情感'],
  },
];

/** 含角色专属字段的表单（fd_exp 仅聆听者必填，fd_topic_speaker 仅倾诉者选填）。 */
const ROLE_FIELDS: PublicRegistrationField[] = [
  {
    id: 'fd_name',
    field_code: 'real_name',
    field_type: 'text',
    label: '姓名',
    source_type: 'standard',
    is_sensitive: false,
    required: true,
    role_scope: 'both',
  },
  {
    id: 'fd_exp',
    field_code: 'listen_experience',
    field_type: 'text',
    label: '聆听经验',
    source_type: 'custom',
    is_sensitive: false,
    required: true,
    role_scope: 'listener',
  },
  {
    id: 'fd_topic_speaker',
    field_code: 'speaker_topic',
    field_type: 'text',
    label: '想倾诉的话题',
    source_type: 'custom',
    is_sensitive: false,
    required: false,
    role_scope: 'speaker',
  },
];

function renderForm(
  overrides: Partial<Parameters<typeof RegistrationForm>[0]> = {},
): ReturnType<typeof vi.fn> {
  const submitRegistration = vi.fn(
    () => Promise.resolve({ id: 'reg_1' } as RegistrationRecord),
  );
  render(
    <RegistrationForm
      fields={FIELDS}
      remaining={{}}
      submitRegistration={submitRegistration}
      onSubmitted={vi.fn()}
      {...overrides}
    />,
  );
  return submitRegistration;
}

describe('RegistrationForm 报名表单', () => {
  it('渲染标准+自定义字段、敏感标记提示与角色选项', () => {
    renderForm();
    expect(screen.getByRole('textbox', { name: /姓名/ })).toBeInTheDocument();
    expect(screen.getByText(/敏感信息：仅经授权的范围可见/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '女' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '学业' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /倾诉者/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /聆听者/ })).toBeInTheDocument();
  });

  it('角色名额满时仅禁用该角色选项（FR-ACT-007）', () => {
    renderForm({ remaining: { speaker: 0, listener: 3 } });
    expect(screen.getByRole('radio', { name: /倾诉者/ })).toBeDisabled();
    expect(screen.getByText(/名额已满/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /聆听者/ })).toBeEnabled();
  });

  it('必填缺失：展示角色与字段错误且不提交', async () => {
    const submitRegistration = renderForm();
    fireEvent.click(screen.getByRole('button', { name: '提交报名' }));
    expect(await screen.findByText('请选择活动角色（倾诉者 / 聆听者）')).toBeInTheDocument();
    expect(screen.getByText('请填写「姓名」')).toBeInTheDocument();
    expect(submitRegistration).not.toHaveBeenCalled();
  });

  it('完整填写：按题型组装载荷提交（number 转数值、多选为数组）', async () => {
    const onSubmitted = vi.fn();
    const submitRegistration = renderForm({ onSubmitted });

    fireEvent.click(screen.getByRole('radio', { name: /倾诉者/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /姓名/ }), { target: { value: '  张三 ' } });
    fireEvent.change(screen.getByLabelText(/年龄/), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('radio', { name: '女' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '学业' }));
    fireEvent.click(screen.getByRole('button', { name: '提交报名' }));

    await waitFor(() => expect(submitRegistration).toHaveBeenCalledTimes(1));
    expect(submitRegistration).toHaveBeenCalledWith({
      activity_role: 'speaker',
      answers: [
        { field_def_id: 'fd_name', value: '张三' },
        { field_def_id: 'fd_age', value: 25 },
        { field_def_id: 'fd_gender', value: 'f' },
        { field_def_id: 'fd_topics', value: ['学业'] },
      ],
    });
    await waitFor(() =>
      expect(onSubmitted).toHaveBeenCalledWith(expect.objectContaining({ id: 'reg_1' })),
    );
  });

  it('提交失败：展示服务端错误文案', async () => {
    const submitRegistration = vi.fn(() => Promise.reject(new Error('无法连接服务器，请检查网络后重试')));
    render(
      <RegistrationForm
        fields={FIELDS}
        remaining={{}}
        submitRegistration={submitRegistration}
        onSubmitted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /聆听者/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /姓名/ }), { target: { value: '张三' } });
    fireEvent.click(screen.getByRole('radio', { name: '男' }));
    fireEvent.click(screen.getByRole('button', { name: '提交报名' }));

    expect(await screen.findByText('无法连接服务器，请检查网络后重试')).toBeInTheDocument();
  });
});

describe('RegistrationForm 分角色渲染（role_scope）', () => {
  it('未选角色时只显示 both 字段，角色专属字段不出现', () => {
    renderForm({ fields: ROLE_FIELDS });
    expect(screen.getByRole('textbox', { name: /姓名/ })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /聆听经验/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /想倾诉的话题/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/专属问题/)).not.toBeInTheDocument();
  });

  it('选定聆听者后显示专属字段与分组小标题', () => {
    renderForm({ fields: ROLE_FIELDS });
    fireEvent.click(screen.getByRole('radio', { name: /聆听者/ }));
    expect(screen.getByText('聆听者专属问题')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /聆听经验/ })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /想倾诉的话题/ })).not.toBeInTheDocument();
  });

  it('角色专属必填校验：聆听者缺专属必填字段时阻止提交', async () => {
    const submitRegistration = renderForm({ fields: ROLE_FIELDS });
    fireEvent.click(screen.getByRole('radio', { name: /聆听者/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /姓名/ }), { target: { value: '张三' } });
    fireEvent.click(screen.getByRole('button', { name: '提交报名' }));
    expect(await screen.findByText('请填写「聆听经验」')).toBeInTheDocument();
    expect(submitRegistration).not.toHaveBeenCalled();
  });

  it('倾诉者提交不受聆听者专属必填影响，载荷只含适用字段', async () => {
    const submitRegistration = renderForm({ fields: ROLE_FIELDS });
    fireEvent.click(screen.getByRole('radio', { name: /倾诉者/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /姓名/ }), { target: { value: '张三' } });
    fireEvent.click(screen.getByRole('button', { name: '提交报名' }));
    await waitFor(() => expect(submitRegistration).toHaveBeenCalledTimes(1));
    expect(submitRegistration).toHaveBeenCalledWith({
      activity_role: 'speaker',
      answers: [{ field_def_id: 'fd_name', value: '张三' }],
    });
  });

  it('切换角色后不再适用字段的已填值被清除且不随提交带出', async () => {
    const submitRegistration = renderForm({ fields: ROLE_FIELDS });
    fireEvent.click(screen.getByRole('radio', { name: /聆听者/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /姓名/ }), { target: { value: '张三' } });
    fireEvent.change(screen.getByRole('textbox', { name: /聆听经验/ }), {
      target: { value: '有三个月经验' },
    });

    // 切换到倾诉者：聆听经验字段隐藏，倾诉者专属字段出现
    fireEvent.click(screen.getByRole('radio', { name: /倾诉者/ }));
    expect(screen.queryByRole('textbox', { name: /聆听经验/ })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /想倾诉的话题/ })).toBeInTheDocument();

    // 提交：载荷不含 fd_exp 残留值
    fireEvent.click(screen.getByRole('button', { name: '提交报名' }));
    await waitFor(() => expect(submitRegistration).toHaveBeenCalledTimes(1));
    expect(submitRegistration).toHaveBeenCalledWith({
      activity_role: 'speaker',
      answers: [{ field_def_id: 'fd_name', value: '张三' }],
    });

    // 切回聆听者：已填值已被清除（而非隐藏保留）
    fireEvent.click(screen.getByRole('radio', { name: /聆听者/ }));
    expect(screen.getByRole('textbox', { name: /聆听经验/ })).toHaveValue('');
  });
});
