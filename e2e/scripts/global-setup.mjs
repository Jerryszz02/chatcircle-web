// Playwright globalSetup：起 E2E 环境（迁移 + fixture + PocketBase + vite preview）。
import { start } from './env.mjs';

export default async function globalSetup() {
  await start();
}
