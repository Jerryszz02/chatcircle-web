import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllSessions, unstubApi } from '../../../test/mockApi';
import { AboutPage } from './AboutPage';

/**
 * 关于我们页测试（/about，2026-08 UI 重构新增）。
 * 覆盖：各内容区块标题、青年心理健康数据点、首场试点成果、
 * 参与入口链接、合作联系方式（仅邮箱）、页脚运营方信息。
 */

function renderAbout() {
  return render(
    <MemoryRouter initialEntries={['/about']}>
      <AboutPage />
    </MemoryRouter>,
  );
}

describe('AboutPage 关于我们', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('展示页面标题与全部内容区块', () => {
    renderAbout();
    expect(screen.getByRole('heading', { name: '关于 Chat Circles' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '我们是谁' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '为什么重要' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '项目模式：一套体系，而非一次活动' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '一场活动怎么走' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '首场试点成果' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '如何参与' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '合作与支持' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '运营方' })).toBeInTheDocument();
  });

  it('展示青年心理健康数据与首场试点成果，并诚实标注样本口径', () => {
    renderAbout();
    expect(screen.getByText('14.8%')).toBeInTheDocument();
    expect(screen.getByText('45.28%')).toBeInTheDocument();
    expect(screen.getByText('77%')).toBeInTheDocument();
    expect(screen.getByText(/小样本自报数据/)).toBeInTheDocument();
  });

  it('提供参与入口（报名活动 / 成为倾听者）与合作联系邮箱', () => {
    renderAbout();
    expect(screen.getByRole('link', { name: '浏览活动并报名' })).toHaveAttribute(
      'href',
      '/activities',
    );
    expect(screen.getByRole('link', { name: '查看培训与活动' })).toHaveAttribute(
      'href',
      '/activities',
    );
    // 联系方式只放邮箱，不放私人微信
    expect(
      screen.getAllByRole('link', { name: 'maggie.yang@empact.sg' })[0],
    ).toHaveAttribute('href', 'mailto:maggie.yang@empact.sg');
  });

  it('页脚体现运营方 Empact', () => {
    renderAbout();
    expect(
      screen.getByText('青年心理健康公益项目 · 由社会企业 Empact 发起与运营'),
    ).toBeInTheDocument();
  });
});
