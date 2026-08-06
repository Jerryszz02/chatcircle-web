import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TemplateSchemaEditor } from './TemplateSchemaEditor';

const INITIAL_SCHEMA = {
  questions: [
    {
      question_code: 'MOOD',
      question_type: 'scale_1_5',
      title: '最近一周情绪状态',
      required: true,
      locked: true,
      is_sensitive: true,
      order_index: 1,
    },
    {
      question_code: 'SAT',
      question_type: 'single_choice',
      title: '整体满意度',
      required: true,
      order_index: 2,
      options: [
        { value: 'good', label: '满意' },
        { value: 'ok', label: '一般' },
      ],
    },
  ],
};

function renderEditor(onSubmit = vi.fn().mockResolvedValue(undefined), initialSchema: unknown = INITIAL_SCHEMA) {
  const onCancel = vi.fn();
  render(
    <TemplateSchemaEditor
      initialSchema={initialSchema}
      saving={false}
      submitLabel="发布"
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  );
  return { onSubmit, onCancel };
}

describe('TemplateSchemaEditor（可视化模板题目编辑器，FR-SUR-001/011）', () => {
  it('从既有版本解析题目列表并展示标记', () => {
    renderEditor();
    expect(screen.getByText('MOOD')).toBeInTheDocument();
    expect(screen.getByText('最近一周情绪状态')).toBeInTheDocument();
    expect(screen.getByText('锁定')).toBeInTheDocument();
    expect(screen.getByText('敏感')).toBeInTheDocument();
    expect(screen.getAllByText('必填')).toHaveLength(2);
  });

  it('新增题目：表单保存后出现在列表', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: '新增题目' }));
    fireEvent.change(screen.getByLabelText(/题目代码/), { target: { value: 'NEW_Q' } });
    fireEvent.change(screen.getByLabelText(/题干/), { target: { value: '新题目' } });
    fireEvent.click(screen.getByRole('button', { name: '保存题目' }));
    expect(screen.getByText('NEW_Q')).toBeInTheDocument();
    expect(screen.getByText('#3')).toBeInTheDocument();
  });

  it('从已发布版本带入的题：question_code 与题型不可改', () => {
    renderEditor();
    const editButtons = screen.getAllByRole('button', { name: '编辑' });
    fireEvent.click(editButtons[0]);
    expect(screen.getByLabelText(/题目代码/)).toBeDisabled();
    expect(screen.getByLabelText('题型')).toBeDisabled();
  });

  it('修改锁定核心题需勾选确认后才能保存', () => {
    renderEditor();
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    fireEvent.change(screen.getByLabelText(/题干/), { target: { value: '改过的题干' } });
    fireEvent.click(screen.getByRole('button', { name: '保存题目' }));
    expect(
      screen.getByText('该题为锁定核心题，修改将影响之后新建的所有问卷，请勾选确认后再保存'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /我确认修改此锁定核心题/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存题目' }));
    expect(screen.getByText('改过的题干')).toBeInTheDocument();
  });

  it('空题目列表提交时报校验错误、不调 onSubmit', async () => {
    const { onSubmit } = renderEditor(vi.fn(), null);
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('至少需要 1 道题目'),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('发布时产出规范化 schema（options_json、order_index 按序重排）', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditor(onSubmit);
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const schema = onSubmit.mock.calls[0][0] as {
      questions: Record<string, unknown>[];
    };
    expect(schema.questions).toHaveLength(2);
    expect(schema.questions[0]).toMatchObject({ question_code: 'MOOD', order_index: 0 });
    expect(schema.questions[1]).toMatchObject({
      question_code: 'SAT',
      order_index: 1,
      options_json: {
        options: [
          { value: 'good', label: '满意' },
          { value: 'ok', label: '一般' },
        ],
      },
    });
    expect(schema.questions[1]).not.toHaveProperty('options');
  });

  it('JSON 原文模式与可视化双向同步', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'JSON 原文' }));
    const textarea = screen.getByLabelText(/题目定义 JSON/);
    expect((textarea as HTMLTextAreaElement).value).toContain('"MOOD"');
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          questions: [{ question_code: 'ONLY', question_type: 'text_short', title: '唯一题' }],
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '可视化编辑' }));
    expect(screen.getByText('ONLY')).toBeInTheDocument();
    expect(screen.queryByText('MOOD')).not.toBeInTheDocument();
  });

  it('onSubmit 抛错时内联展示错误文案', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('模板已停用'));
    renderEditor(onSubmit);
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('模板已停用'));
  });
});
