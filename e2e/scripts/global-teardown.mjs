// Playwright globalTeardown：停 E2E 环境（PocketBase + vite preview）。
import { stop } from './env.mjs';

export default async function globalTeardown() {
  await stop();
}
