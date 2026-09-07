import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllSessions, unstubApi } from '../../../test/mockApi';
import { ParticipantAccessPanel } from './ParticipantAccessPanel';

describe('ParticipantAccessPanel 登录面板', () => {
  beforeEach(clearAllSessions);
  afterEach(unstubApi);

  it('默认展示账号密码登录，可切换到验证码/注册/找回密码', () => {
    render(<ParticipantAccessPanel onSuccess={vi.fn()} />);
    // 默认：账号密码登录
    expect(screen.getByRole('textbox', { name: /^用户名或手机号/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();

    // 切到验证码登录
    fireEvent.click(screen.getByRole('button', { name: '手机验证码登录' }));
    expect(screen.getByRole('textbox', { name: /^手机号/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '使用账号密码登录' }));
    expect(screen.getByRole('textbox', { name: /^用户名或手机号/ })).toBeInTheDocument();

    // 切到注册（密码框为 password 类型，用 label 定位；先请求验证码才出现提交钮）
    fireEvent.click(screen.getByRole('button', { name: '注册账号' }));
    expect(screen.getByLabelText(/^确认密码/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '获取验证码' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '已有账号，返回登录' }));

    // 切到找回密码
    fireEvent.click(screen.getByRole('button', { name: '忘记密码' }));
    expect(screen.getByRole('button', { name: '获取验证码' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回登录' }));
    expect(screen.getByRole('textbox', { name: /^用户名或手机号/ })).toBeInTheDocument();
  });

  it('保留存量用户名账号迁移入口', () => {
    render(<ParticipantAccessPanel onSuccess={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '使用原用户名账号迁移' }));
    expect(screen.getByRole('textbox', { name: /^用户名/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录原账号' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回登录' }));
    expect(screen.getByRole('textbox', { name: /^用户名或手机号/ })).toBeInTheDocument();
  });
});
