import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToastProvider } from '../../../shared/ui';
import type { SurveyQuestionRecord } from '../../../shared/api/types';
import { clearAllSessions, stubApi, unstubApi, type ApiMock } from '../../../test/mockApi';
import { SurveyPage } from './SurveyPage';

/**
 * 问卷填写页测试（FR-SUR-006/007/008/009 前端侧）。
 * 覆盖：资格失败分因展示、7 题型表单渲染、必填校验（不发起提交）、
 * 草稿保存、正式提交确认后锁定为只读、已提交答案只读查看。
 */

function question(partial: Partial<SurveyQuestionRecord>): SurveyQuestionRecord {
  return {
    id: 'q1',
    activity_survey_id: 'as1',
    question_code: 'Q1',
    source_type: 'standard',
    question_type: 'text_short',
    title: '题目',
    required: false,
    locked: false,
    is_sensitive: false,
    order_index: 1,
    created: '',
    updated: '',
    ...partial,
  };
}

const QUESTIONS: SurveyQuestionRecord[] = [
  question({
    id: 'q0',
    question_code: 'INFO_1',
    question_type: 'info',
    title: '本问卷仅用于活动改进，答案不涉及对错。',
    order_index: 1,
  }),
  question({
    id: 'q1',
    question_code: 'MOOD',
    question_type: 'single_choice',
    title: '您最近一周的心情如何？',
    required: true,
    order_index: 2,
    options_json: [
      { value: 'good', label: '好' },
      { value: 'bad', label: '差' },
    ],
  }),
  question({
    id: 'q2',
    question_code: 'SAT',
    question_type: 'scale_1_5',
    title: '对活动的总体满意度',
    required: true,
    order_index: 3,
  }),
  question({
    id: 'q3',
    question_code: 'NOTE',
    question_type: 'text_long',
    title: '想说的话（选填）',
    order_index: 4,
  }),
];

function metaBody(overrides: Record<string, unknown> = {}) {
  return {
    survey: {
      id: 'as1',
      activity_id: 'act1',
      title: '活动前测问卷',
      survey_code: 'CC_X_PRE',
      status: 'open',
      role_scope: 'both',
    },
    activity: { id: 'act1', title: '八月光影活动' },
    questions: QUESTIONS,
    eligible: true,
    my_submission: null,
    ...overrides,
  };
}

function renderSurvey(qrToken = 'tok_1') {
  return render(
    <MemoryRouter initialEntries={[`/survey/${qrToken}`]}>
      <ToastProvider>
        <Routes>
          <Route path="/survey/:qrToken" element={<SurveyPage />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function callsTo(mock: ApiMock, fragment: string) {
  return mock.calls.filter((c) => c.url.includes(fragment));
}

describe('SurveyPage 问卷填写', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('资格失败：按原因分开展示（FR-SUR-006）', async () => {
    stubApi({
      'GET /api/cc/surveys/': {
        body: metaBody({ eligible: false, questions: [], reasons: ['not_approved', 'role_mismatch'] }),
      },
    });
    renderSurvey();
    expect(await screen.findByText('报名未通过审核')).toBeInTheDocument();
    expect(screen.getByText('本问卷不适用于您的角色')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '正式提交' })).not.toBeInTheDocument();
  });

  it('问卷已结束（ended）', async () => {
    stubApi({
      'GET /api/cc/surveys/': {
        body: metaBody({ eligible: false, questions: [], reasons: ['ended'] }),
      },
    });
    renderSurvey();
    expect(await screen.findByText('问卷已结束')).toBeInTheDocument();
  });

  it('资格通过：渲染说明/单选/量表/多行题目与操作按钮', async () => {
    stubApi({ 'GET /api/cc/surveys/': { body: metaBody() } });
    renderSurvey();
    expect(await screen.findByText('您最近一周的心情如何？')).toBeInTheDocument();
    expect(screen.getByText('本问卷仅用于活动改进，答案不涉及对错。')).toBeInTheDocument();
    expect(screen.getByText('对活动的总体满意度')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '正式提交' })).toBeInTheDocument();
  });

  it('必填未答：展示错误且不发起提交请求', async () => {
    const mock = stubApi({ 'GET /api/cc/surveys/': { body: metaBody() } });
    renderSurvey();
    fireEvent.click(await screen.findByRole('button', { name: '正式提交' }));
    expect((await screen.findAllByText('本题为必答题')).length).toBe(2);
    expect(callsTo(mock, '/submit')).toHaveLength(0);
  });

  it('草稿保存：仅下发已作答题（FR-SUR-008）', async () => {
    const mock = stubApi({
      'GET /api/cc/surveys/': { body: metaBody() },
      'POST /api/cc/activity-surveys/': { body: { submission: { id: 'sub1', status: 'draft' } } },
    });
    renderSurvey();
    fireEvent.click(await screen.findByRole('radio', { name: '好' }));
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() => expect(callsTo(mock, '/draft')).toHaveLength(1));
    const draftCallIndex = mock.calls.findIndex((c) => c.url.includes('/draft'));
    expect(mock.bodyOf(draftCallIndex)).toEqual({
      answers: [{ question_code: 'MOOD', value: 'good' }],
    });
    expect(await screen.findByText('草稿已保存，可稍后继续填写')).toBeInTheDocument();
  });

  it('正式提交：二次确认后提交并锁定为只读视图（FR-SUR-008）', async () => {
    const mock = stubApi({
      'GET /api/cc/surveys/': { body: metaBody() },
      'POST /api/cc/activity-surveys/': {
        body: { submission: { id: 'sub1', status: 'submitted', submitted_at: '2026-08-05 13:00:00.000Z' } },
      },
    });
    renderSurvey();
    fireEvent.click(await screen.findByRole('radio', { name: '好' }));
    fireEvent.click(screen.getByRole('radio', { name: '5' }));
    fireEvent.click(screen.getByRole('button', { name: '正式提交' }));

    // 二次确认（提交后锁定提示）
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }));

    await waitFor(() => expect(callsTo(mock, '/submit')).toHaveLength(1));
    const submitCallIndex = mock.calls.findIndex((c) => c.url.includes('/submit'));
    expect(mock.bodyOf(submitCallIndex)).toEqual({
      answers: [
        { question_code: 'MOOD', value: 'good' },
        { question_code: 'SAT', value: 5 },
      ],
    });
    expect(await screen.findByText('我的答卷（只读）')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '正式提交' })).not.toBeInTheDocument();
  });

  it('已提交：进入本人答案只读视图（FR-SUR-009）', async () => {
    stubApi({
      'GET /api/cc/surveys/': {
        body: metaBody({
          my_submission: { id: 'sub1', status: 'submitted', submitted_at: '2026-08-05 13:00:00.000Z' },
          my_answers: [
            { question_code: 'MOOD', value_json: 'good' },
            { question_code: 'SAT', value_json: 4 },
          ],
        }),
      },
    });
    renderSurvey();
    expect(await screen.findByText('我的答卷（只读）')).toBeInTheDocument();
    expect(screen.getByText('已提交')).toBeInTheDocument();
    expect(screen.getByText('好')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存草稿' })).not.toBeInTheDocument();
  });
});
