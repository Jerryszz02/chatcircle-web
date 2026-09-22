#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { DEFAULT_PB_URL, validateUrl, privateWrite } from './local-config.mjs';
export { validateUrl, privateWrite } from './local-config.mjs';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const clients = ['codex', 'claude', 'workbuddy'];

export function mergeJsonConfig(file, entry) {
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  let config;
  try { config = original === null ? {} : JSON.parse(original); } catch {
    throw new Error('客户端 JSON 配置无法解析，已保留原文件。');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) {
    throw new Error('客户端配置格式不正确，已保留原文件。');
  }
  if (original !== null) privateWrite(`${file}.chatcircle-${Date.now()}-${randomUUID()}.bak`, original);
  config.mcpServers = { ...config.mcpServers, chatcircle: entry };
  privateWrite(file, JSON.stringify(config, null, 2) + '\n');
}

export function clientConfigPath(client, home = os.homedir(), platform = process.platform) {
  if (client === 'workbuddy') return path.join(home, '.workbuddy', 'mcp.json');
  if (client === 'claude') {
    if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    if (platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    throw new Error('Claude Desktop 自动配置支持 macOS / Windows。');
  }
  if (client === 'codex') return path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  throw new Error('不支持的客户端。');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error('命令执行失败，请查看上方诊断。');
}

export async function install() {
  const { values } = parseArgs({ options: {
    client: { type: 'string' }, url: { type: 'string' },
    'install-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('用法：node mcp/install.mjs --client codex|claude|workbuddy [--url HTTPS后端地址]\n默认连接 https://chatcircle.empact.cn。安装无需账号；首次使用时在浏览器登录现有超管账号。\n安装到 ~/.local/share/chatcircle-mcp；可用 --install-dir 指定固定目录。');
    return;
  }
  const client = values.client || 'codex';
  if (!clients.includes(client)) throw new Error('客户端须为 codex、claude 或 workbuddy。');
  const configFile = clientConfigPath(client);
  // Fail before installing if the Codex CLI cannot safely register the server.
  if (client === 'codex') {
    const probe = spawnSync('codex', ['mcp', 'add', '--help'], { stdio: 'ignore' });
    if (probe.error || probe.status !== 0) throw new Error('未找到可执行的 Codex CLI，请先安装并确认 codex mcp add --help 可用。');
  }
  const installDir = path.resolve(values['install-dir'] || path.join(os.homedir(), '.local', 'share', 'chatcircle-mcp'));
  if (installDir === sourceDir) throw new Error('安装目录必须独立于源码仓库。');
  for (let directory = installDir; ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git'))) throw new Error('安装目录不能位于 Git 仓库内，避免凭据误入库。');
    if (directory === path.dirname(directory)) break;
  }
  if (fs.existsSync(installDir)) {
    if (fs.lstatSync(installDir).isSymbolicLink()) throw new Error('安装目录不能是符号链接。');
    const files = fs.readdirSync(installDir);
    if (files.length && !(files.includes('launch.mjs') && files.includes('package.json'))) {
      throw new Error('安装目录非空且不是已有 MCP 安装，请选择独立目录。');
    }
  }
  const settingsFile = path.join(installDir, 'settings.json');
  const legacyCredentials = path.join(installDir, 'credentials.json');
  const previousFile = fs.existsSync(settingsFile) ? settingsFile : legacyCredentials;
  let previous = {};
  if (fs.existsSync(previousFile)) {
    try {
      previous = JSON.parse(fs.readFileSync(previousFile, 'utf8'));
      if (!previous || Array.isArray(previous) || typeof previous !== 'object') throw new Error('invalid config');
    } catch {
      throw new Error('已有安装配置损坏，请修复后重试；未覆盖配置。');
    }
  }
  const url = validateUrl(values.url || process.env.CC_PB_URL || previous.CC_PB_URL || DEFAULT_PB_URL);
  const dataDir = path.join(installDir, 'data');
  const settings = { CC_PB_URL: url, CC_DATA_DIR: dataDir, CC_REPORT_DIR: dataDir };
  fs.mkdirSync(installDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(installDir).isSymbolicLink()) throw new Error('安装目录不能是符号链接。');
  fs.chmodSync(installDir, 0o700);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const file of ['package.json', 'package-lock.json', 'server.js', 'launch.mjs', 'check.mjs', 'auth.mjs', 'local-config.mjs']) {
    privateWrite(path.join(installDir, file), fs.readFileSync(path.join(sourceDir, file)));
  }
  console.log('安装依赖…');
  const cleanEnv = { ...process.env };
  delete cleanEnv.CC_AGENT_PASSWORD;
  delete cleanEnv.CC_AGENT_EMAIL;
  const npmArgs = ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'];
  if (process.platform === 'win32') {
    // Fixed command only; no user input is interpolated into the shell.
    run('cmd.exe', ['/d', '/s', '/c', 'npm ci --ignore-scripts --omit=dev --no-audit --no-fund'], { cwd: installDir, env: cleanEnv });
  } else {
    run('npm', npmArgs, { cwd: installDir, env: cleanEnv });
  }
  privateWrite(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  console.log('验证 MCP 连接与工具注册（无需登录）…');
  run(process.execPath, [path.join(installDir, 'check.mjs')], { cwd: installDir, env: cleanEnv, timeout: 60000 });
  const launcher = path.join(installDir, 'launch.mjs');
  if (client === 'codex') {
    if (fs.existsSync(configFile)) privateWrite(`${configFile}.chatcircle-${Date.now()}-${randomUUID()}.bak`, fs.readFileSync(configFile));
    run('codex', ['mcp', 'add', 'chatcircle', '--', process.execPath, launcher], { env: cleanEnv });
  } else {
    mergeJsonConfig(configFile, { command: process.execPath, args: [launcher] });
  }
  // Upgrade from the password-based installer without retaining its plaintext password.
  if (fs.existsSync(legacyCredentials)) fs.unlinkSync(legacyCredentials);
  console.log(`安装完成：${client} / chatcircle\n客户端配置：${configFile}\n运行目录：${installDir}\n后端：${url}\n请重启客户端，按需信任 chatcircle，然后说“使用 chatcircle 列出最近活动”。\n首次使用会提供本机登录链接，用现有超级管理员账号登录即可。密码不落盘。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install().catch((error) => { console.error(`[安装失败] ${error.message}`); process.exitCode = 1; });
}
