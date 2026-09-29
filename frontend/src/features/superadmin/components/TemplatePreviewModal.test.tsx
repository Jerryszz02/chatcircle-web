import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TemplatePreviewModal } from './TemplatePreviewModal';

const SCHEMA = {
  questions: [
    {
      question_code: 'INTRO',
      question_type: 'info',
      title: '本问卷用于活动前测，请如实填写',
      required: false,
      locked: true,
      is_sensitive: false,
      order_index: 0,
    },
    {
      question_code: 'MOOD',
      question_type: 'single_choice',
      title: '你最近一周的心情如何？',
      required: true,
      locked: false,
      is_sensitive: true,
      order_index: 1,
      options_json: {
        options: [
          { value: 'good', label: '很好' },
          { value: 'bad', label: '不太好' },
        ],
      },
    },
    {
      question_code: 'SCORE',
      question_type: 'scale_1_5',
      title: '睡眠质量自评',
      required: false,
      locked: false,
      is_sensitive: false,
      order_index: 2,
    },
  ],
};

const REGISTRATION_SCHEMA = {
  kind: 'registration',
  role_scope: 'speaker',
  fields: [
    {
      id: 'field_gender', field_code: 'gender', field_type: 'single_choice', label: '性别',
      source_type: 'standard', is_sensitive: false, required_default: false, role_scope: 'speaker',
      options_json: [{ value: 'Man', label: '男' }, { value: 'other', label: '自我描述' }],
      config_json: { section: '基本信息', order_index: 2 },
    },
    {
      id: 'field_email', field_code: 'email', field_type: 'text', label: '电子邮箱',
      source_type: 'standard', is_sensitive: false, required_default: true, role_scope: 'speaker',
      config_json: { section: '基本信息', order_index: 1, input_type: 'email' },
    },
    {
      id: 'field_gender_other', field_code: 'gender_other', field_type: 'text', label: '性别自我描述',
      source_type: 'standard', is_sensitive: false, required_default: true, role_scope: 'speaker',
      config_json: { section: '基本信息', order_index: 3, show_when: { field_code: 'gender', value: 'other' } },
    },
    {
      id: 'field_story', field_code: 'story', field_type: 'text', label: '最近想聊的话',
      source_type: 'standard', is_sensitive: false, required_default: false, role_scope: 'speaker',
      config_json: { section: '参与背景', order_index: 1, input_type: 'textarea', hint: '一句话即可' },
    },
    {
      id: 'field_consent', field_code: 'consent', field_type: 'single_choice', label: '我同意参与',
      source_type: 'standard', is_sensitive: false, required_default: true, role_scope: 'speaker',
      options_json: [{ value: 'agree', label: '同意' }],
      config_json: { section: '参与约定', order_index: 1, input_type: 'ack' },
    },
  ],
};

describe('TemplatePreviewModal 模板内容预览', () => {
  it('按参与者填写样式渲染全部题型与标识 badge', () => {
    render(
      <TemplatePreviewModal open title="内容预览：v1" schemaJson={SCHEMA} onClose={vi.fn()} />,
    );
    // 说明题文本、选择题题干、量表题干
    expect(screen.getByText('本问卷用于活动前测，请如实填写')).toBeInTheDocument();
    expect(screen.getByText('你最近一周的心情如何？')).toBeInTheDocument();
    expect(screen.getByText('睡眠质量自评')).toBeInTheDocument();
    // 锁定 / 敏感 / 必填 badge
    expect(screen.getByText('锁定题（机构不可改）')).toBeInTheDocument();
    expect(screen.getByText('敏感题')).toBeInTheDocument();
    expect(screen.getByText('必填')).toBeInTheDocument();
    // 选择题选项真实渲染为 radio
    expect(screen.getByRole('radio', { name: '很好' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '不太好' })).toBeInTheDocument();
  });

  it('可交互试填但不提交数据', () => {
    render(
      <TemplatePreviewModal open title="内容预览：v1" schemaJson={SCHEMA} onClose={vi.fn()} />,
    );
    const option = screen.getByRole('radio', { name: '很好' });
    fireEvent.click(option);
    expect(option).toBeChecked();
  });

  it('报名模板按固定角色展示真实字段，校验后仍停留在本地预览', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      render(
        <TemplatePreviewModal open title="倾诉者报名表预览" schemaJson={REGISTRATION_SCHEMA} onClose={vi.fn()} />,
      );
      expect(screen.queryByRole('radio', { name: /活动角色/ })).not.toBeInTheDocument();
      expect(screen.getByRole('region', { name: '基本信息' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: '最近想聊的话' }).tagName).toBe('TEXTAREA');
      expect(screen.getByText('一句话即可')).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: /我同意参与/ })).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: '性别自我描述' })).not.toBeInTheDocument();

      fireEvent.change(screen.getByRole('textbox', { name: '电子邮箱' }), { target: { value: 'bad' } });
      fireEvent.click(screen.getByRole('button', { name: '检查填写' }));
      expect(await screen.findByText('「电子邮箱」邮箱格式不正确')).toBeInTheDocument();

      fireEvent.change(screen.getByRole('textbox', { name: '电子邮箱' }), { target: { value: 'person@example.com' } });
      fireEvent.click(screen.getByRole('radio', { name: '自我描述' }));
      fireEvent.click(screen.getByRole('button', { name: '检查填写' }));
      expect(await screen.findByText('请填写「性别自我描述」')).toBeInTheDocument();
      fireEvent.change(screen.getByRole('textbox', { name: '性别自我描述' }), { target: { value: '自己的描述' } });
      fireEvent.click(screen.getByRole('checkbox', { name: /我同意参与/ }));
      fireEvent.click(screen.getByRole('button', { name: '检查填写' }));
      expect(await screen.findByRole('status')).toHaveTextContent('填写检查通过');
      await waitFor(() => expect(fetchSpy).not.toHaveBeenCalled());
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('后测预览显示量表文案与 Q21 条件题，并在本地校验', async () => {
    const schema = { questions: [
      { question_code: 'CPOST_Q13', question_type: 'scale_0_10', title: '当前压力', required: false, locked: true, is_sensitive: false, order_index: 1,
        validation_json: { labels: { 0: '没有压力', 10: '压力极大' } } },
      { question_code: 'CPOST_Q21', question_type: 'multi_choice', title: '接下来想探索什么？', required: true, locked: true, is_sensitive: false, order_index: 2,
        options_json: [{ value: 'other', label: '其他' }, { value: 'nothing_for_now', label: '暂时没有' }],
        validation_json: { exclusive_values: ['nothing_for_now'] } },
      { question_code: 'CPOST_Q21_OTHER', question_type: 'text_long', title: '其他（请注明）', required: true, locked: true, is_sensitive: false, order_index: 3,
        validation_json: { show_when: { question_code: 'CPOST_Q21', value: 'other' } } },
    ] };
    render(<TemplatePreviewModal open title="Chatter 后测预览" schemaJson={schema} onClose={vi.fn()} />);
    expect(screen.getByText('没有压力')).toBeInTheDocument();
    expect(screen.getByText('压力极大')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '其他（请注明）' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '其他' }));
    fireEvent.click(screen.getByRole('button', { name: '检查填写' }));
    expect(await screen.findByText('本题为必答题')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '其他（请注明）' }), { target: { value: '另一个方向' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '暂时没有' }));
    expect(screen.queryByRole('textbox', { name: '其他（请注明）' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '检查填写' }));
    expect(await screen.findByRole('status')).toHaveTextContent('填写检查通过');
  });

  it('schema 结构不符时降级为占位提示', () => {
    render(
      <TemplatePreviewModal open title="内容预览" schemaJson={{ foo: 1 }} onClose={vi.fn()} />,
    );
    expect(screen.getByText('该版本未包含可解析的题目定义。')).toBeInTheDocument();
  });

  it('open=false 时不渲染内容', () => {
    render(
      <TemplatePreviewModal
        open={false}
        title="内容预览"
        schemaJson={SCHEMA}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('睡眠质量自评')).not.toBeInTheDocument();
  });
});
