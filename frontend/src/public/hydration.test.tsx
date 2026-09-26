import { act } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderPublicBody } from '../entry-public-server';
import { PublicClientApp } from './clientPages';
import { matchPublicRoute } from './routes';
import type { PublicPageData } from './types';

/**
 * SSR/CSR 一致性回归测试（jsdom）：renderPublicBody 输出直接作为 hydrate 容器，
 * React hydration 比对失败会打 console.error（"did not match" / "hydrat"）。
 * 首帧数据同源（同一 data 对象），不允许出现任何 hydration 警告；
 * 挂载后 ClientOnly 岛屿替换占位（登录占位 <a> → HeaderActions 登录菜单按钮）。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GENERATED_AT = '2026-09-26T00:00:00.000Z';

const ACTIVITY = {
  id: 'act1',
  title: '八月光影茶话会',
  activity_code: 'CC_SG_202608_01',
  description: '一场关于光影与倾诉的聚会。',
  location: '三楼活动室',
  start_time: '2026-10-10 02:00:00.000Z',
  end_time: '2026-10-10 04:00:00.000Z',
  status: 'published' as const,
  capacity_total: 20,
  registration: { open: true, reason: null, remaining_total: 5 },
};

function makeContainer(pathname: string, data: PublicPageData): HTMLElement {
  const match = matchPublicRoute(pathname);
  if (!match) throw new Error(`测试路径未命中公开路由：${pathname}`);
  const container = document.createElement('div');
  container.innerHTML = renderPublicBody(match, data);
  document.body.appendChild(container);
  return container;
}

async function hydrateAndCaptureErrors(
  container: HTMLElement,
  pathname: string,
  data: PublicPageData,
): Promise<string[]> {
  const match = matchPublicRoute(pathname);
  if (!match) throw new Error(`测试路径未命中公开路由：${pathname}`);
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  try {
    await act(async () => {
      hydrateRoot(
        container,
        <StrictMode>
          <PublicClientApp data={data} match={match} />
        </StrictMode>,
      );
    });
  } finally {
    spy.mockRestore();
  }
  return errors.filter((line) => /did not match|hydrat/i.test(line));
}

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('SSR 与 hydrate 首帧逐字节一致', () => {
  it('首页：无 hydration 警告；挂载后账号区切换为登录菜单', async () => {
    const data: PublicPageData = {
      kind: 'home',
      generatedAt: GENERATED_AT,
      activities: [ACTIVITY],
      activitiesError: null,
      posts: [],
      postsError: null,
    };
    const container = makeContainer('/', data);
    expect(container.innerHTML).toContain('八月光影茶话会');
    const hydrationErrors = await hydrateAndCaptureErrors(container, '/', data);
    expect(hydrationErrors).toEqual([]);
    // ClientOnly 挂载后：占位登录 <a> 被 HeaderActions 的登录菜单按钮替换
    expect(container.querySelector('.ccp-site-actions button')).not.toBeNull();
  });

  it('现有活动页：问卷区占位与 SSR 一致，挂载后保持匿名指引态（未登录）', async () => {
    const data: PublicPageData = {
      kind: 'activities',
      generatedAt: GENERATED_AT,
      activities: [ACTIVITY],
      activitiesError: null,
    };
    const container = makeContainer('/activities', data);
    expect(container.innerHTML).toContain('问卷通过活动现场的二维码进入');
    const hydrationErrors = await hydrateAndCaptureErrors(container, '/activities', data);
    expect(hydrationErrors).toEqual([]);
    expect(container.innerHTML).toContain('登录查看我的问卷');
  });

  it('活动详情页：无 hydration 警告，未登录不出现配对卡', async () => {
    const data: PublicPageData = {
      kind: 'activity',
      generatedAt: GENERATED_AT,
      detail: {
        activity: { ...ACTIVITY, capacity_speaker: 10, capacity_listener: 10 },
        registration: { open: true, reason: null, remaining_total: 5 },
      },
    };
    const container = makeContainer('/a/act1', data);
    const hydrationErrors = await hydrateAndCaptureErrors(container, '/a/act1', data);
    expect(hydrationErrors).toEqual([]);
    expect(container.innerHTML).not.toContain('我的现场编号');
  });
});
