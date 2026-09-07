import { fireEvent, render, screen } from '@testing-library/react';
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
