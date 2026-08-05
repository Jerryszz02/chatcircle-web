import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RegistrationRecord } from '../../../shared/api/types';
import type { PublicRegistrationField } from '../api';
import { RegistrationForm } from './RegistrationForm';

/**
 * 报名表单组件测试（FR-REG-001/002/004、FR-ACT-007 前端侧）。
 * 覆盖：标准+自定义字段渲染、敏感标记提示、必填校验、角色名额满禁用、
 * 提交载荷（题型值类型与字段 id）。
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
  },
  {
    id: 'fd_age',
    field_code: 'age',
    field_type: 'number',
    label: '年龄',
    source_type: 'standard',
    is_sensitive: false,
    required: false,
  },
  {
    id: 'fd_gender',
    field_code: 'gender',
    field_type: 'single_choice',
    label: '性别',
    source_type: 'custom',
    is_sensitive: false,
    required: true,
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
    options_json: ['学业', '情感'],
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
