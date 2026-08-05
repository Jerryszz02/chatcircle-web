// Chat Circles E2E 测试环境起停脚本（test-plan §5 主链路的运行底座）。
// 职责：
//   start：临时 pb_data → 应用全部迁移 → 创建超级管理员 → 注入最小 fixture（seed.mjs）
//           → 启动 PocketBase（含 pb_hooks）→ 构建前端 → vite preview → 写状态文件；
//   stop ：按状态文件停止 PocketBase 与 vite preview。
// 数据隔离：每次 start 重建 e2e/.runtime（含全新 pb_data），与本地开发库互不影响，可重复跑。
//
// 用法：
//   node scripts/env.mjs start   # CLI 方式（进程驻留，供手工调试）
//   node scripts/env.mjs stop
//   Playwright 运行时由 global-setup.mjs / global-teardown.mjs 自动调用，无需手工起停。
//
// 环境变量：
//   PB_BINARY          PocketBase 二进制路径（默认 backend/pocketbase；CI 下载 linux 版后注入）
//   E2E_PB_PORT        PocketBase 端口（默认 18090，避开开发常用 8090）
//   E2E_WEB_PORT       vite preview 端口（默认 14173）
//   E2E_SKIP_BUILD=1   跳过前端构建（复用 frontend/dist，需 dist 已按同一 PB 地址构建）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedTemplatesSql, seedBizData } from './seed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E2E_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(E2E_DIR, '..');
const RUNTIME_DIR = path.join(E2E_DIR, '.runtime');
const STATE_FILE = path.join(RUNTIME_DIR, 'state.json');

const PB_PORT = Number(process.env.E2E_PB_PORT || 18090);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 14173);
const PB_URL = `http://127.0.0.1:${PB_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const PB_BINARY = process.env.PB_BINARY || path.join(REPO_ROOT, 'backend', 'pocketbase');

// E2E 专用超级管理员凭据（仅本地/CI 临时实例使用，非生产 secret）
const SUPER_EMAIL = 'e2e_super@cc.local';
const SUPER_PASSWORD = 'e2e_super_pass_123';

/** 本模块直接启动的子进程（globalTeardown 路径用；CLI 路径改走 state.json 里的 pid）。 */
const children = [];

function log(msg) {
  console.log(`[e2e-env] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`命令失败（exit ${res.status}）：${cmd} ${args.join(' ')}`);
  }
}

function spawnLong(cmd, args, logFile, opts = {}) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(cmd, args, {
    stdio: ['ignore', out, out],
    detached: opts.detached === true,
    ...opts,
  });
  if (opts.detached === true) child.unref();
  children.push(child);
  return child;
}

/** 轮询等待 URL 可访问。 */
async function waitFor(url, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 401 || res.status === 404) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`等待 ${label} 超时（${url}）：${lastErr}`);
}

export async function start({ detached = false } = {}) {
  if (!fs.existsSync(PB_BINARY)) {
    throw new Error(`找不到 PocketBase 二进制：${PB_BINARY}（可用 PB_BINARY 环境变量指定）`);
  }

  // 1. 全新运行目录：保证测试数据隔离、可重复跑
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
  const pbData = path.join(RUNTIME_DIR, 'pb_data');
  fs.mkdirSync(pbData, { recursive: true });

  // 2. 空库顺序应用全部迁移（与 CI backend-migrations job 同一入口）
  log('应用 pb_migrations …');
  run(PB_BINARY, [
    'migrate', 'up',
    '--dir', pbData,
    '--migrationsDir', path.join(REPO_ROOT, 'backend', 'pb_migrations'),
  ]);

  // 3. 创建 E2E 超级管理员
  run(PB_BINARY, ['superuser', 'create', SUPER_EMAIL, SUPER_PASSWORD, '--dir', pbData]);

  // 4. 模板 fixture 经 SQL 直插（须在 serve 启动前执行，避免 WAL 竞争）：
  //    survey_templates.current_version_id 为必填循环引用，集合 API 无法创建（迁移 12 注释）。
  //    TODO(待统一)：backend/scripts/ 标准种子脚本就绪后改调标准脚本，本步骤与其对齐。
  log('注入模板 fixture（SQL）…');
  seedTemplatesSql(path.join(pbData, 'data.db'));

  // 5. 启动 PocketBase（挂 pb_hooks）
  log(`启动 PocketBase：${PB_URL}`);
  const pb = spawnLong(
    PB_BINARY,
    ['serve', `--http=127.0.0.1:${PB_PORT}`, '--dir', pbData,
     '--hooksDir', path.join(REPO_ROOT, 'backend', 'pb_hooks')],
    path.join(RUNTIME_DIR, 'pocketbase.log'),
    { detached },
  );
  await waitFor(`${PB_URL}/api/health`, 'PocketBase');

  // 6. 业务 fixture（机构/报名字段/管理员/已发布活动，走真实 API）
  log('注入业务 fixture（HTTP API）…');
  const fixture = await seedBizData(PB_URL, SUPER_EMAIL, SUPER_PASSWORD);

  // 7. 前端构建（指向本实例；vite preview 无 /api 代理，故以 VITE_PB_URL 直连）
  if (process.env.E2E_SKIP_BUILD === '1') {
    log('跳过前端构建（E2E_SKIP_BUILD=1）');
  } else {
    log('构建前端（VITE_PB_URL 指向测试实例）…');
    run('npm', ['run', 'build'], {
      cwd: path.join(REPO_ROOT, 'frontend'),
      env: { ...process.env, VITE_PB_URL: PB_URL },
    });
  }

  // 8. vite preview 伺服构建产物
  log(`启动 vite preview：${WEB_URL}`);
  const web = spawnLong(
    'npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'],
    path.join(RUNTIME_DIR, 'vite-preview.log'),
    { cwd: path.join(REPO_ROOT, 'frontend'), detached },
  );
  await waitFor(WEB_URL, 'vite preview');

  // 9. 状态文件：测试与 stop 共用
  const state = {
    pbUrl: PB_URL,
    webUrl: WEB_URL,
    superEmail: SUPER_EMAIL,
    superPassword: SUPER_PASSWORD,
    pids: { pocketbase: pb.pid, vite: web.pid },
    fixture,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log(`环境就绪：web=${WEB_URL} pb=${PB_URL} activity=${fixture.activityId}`);
  return state;
}

export async function stop() {
  // 优先杀本进程持有的子进程，再按状态文件 pid 兜底（CLI 独立运行场景）
  for (const child of children.splice(0)) {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const pid of Object.values(state.pids || {})) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ }
    }
  }
  log('环境已停止（.runtime 保留日志与 pb_data 供排查，下次 start 自动重建）');
}

export function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(`状态文件不存在：${STATE_FILE}（请先运行 env start 或 playwright globalSetup）`);
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

// CLI 入口
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'start') {
    await start({ detached: true });
  } else if (cmd === 'stop') {
    await stop();
  } else {
    console.error('用法：node scripts/env.mjs start|stop');
    process.exit(1);
  }
}
