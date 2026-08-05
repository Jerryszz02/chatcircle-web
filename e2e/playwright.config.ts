import { defineConfig } from '@playwright/test';

/**
 * Chat Circles E2E（test-plan §5 主链路，L4 层）。
 * - 仅 Chromium、移动端 viewport 360×740（PRD §13 手机优先）；
 * - 环境由 globalSetup 自举（见 scripts/env.mjs），测试结束自动停止；
 * - 单 worker 串行：主链路各步骤共享同一活动/报名状态。
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './scripts/global-setup.mjs',
  globalTeardown: './scripts/global-teardown.mjs',
  use: {
    viewport: { width: 360, height: 740 },
    // 失败时保留截图与 trace，CI 上传为 artifact（test-plan §8）
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
