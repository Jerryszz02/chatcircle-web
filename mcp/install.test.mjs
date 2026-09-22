import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validateUrl, mergeJsonConfig, privateWrite, clientConfigPath } from './install.mjs';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc mcp test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function execute(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('backend URL accepts HTTPS and loopback only, without embedded credentials', () => {
  for (const value of ['https://example.com/', 'http://127.0.0.1:8090', 'http://localhost:8090', 'http://[::1]:8090']) {
    assert.ok(validateUrl(value));
  }
  for (const value of ['http://example.com', 'file:///etc/passwd', 'https://user:password@example.com', 'https://example.com?token=x', 'https://example.com#secret', 'invalid']) {
    assert.throws(() => validateUrl(value));
  }
});

test('JSON registration preserves unrelated settings, backs up original, and is repeatable', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'mcp.json');
  const original = JSON.stringify({ preferences: { theme: 'dark' }, mcpServers: { other: { command: 'other' }, chatcircle: { command: 'old' } } });
  fs.writeFileSync(file, original);
  const entry = { command: process.execPath, args: ['/a path/launch.mjs'] };
  mergeJsonConfig(file, entry);
  mergeJsonConfig(file, entry);
  const current = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(current.mcpServers, { other: { command: 'other' }, chatcircle: entry });
  assert.deepEqual(current.preferences, { theme: 'dark' });
  assert.ok(fs.readdirSync(dir).some((name) => name.endsWith('.bak') && fs.readFileSync(path.join(dir, name), 'utf8') === original));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('invalid JSON and invalid mcpServers are never overwritten', (t) => {
  const file = path.join(scratch(t), 'mcp.json');
  for (const original of ['{broken', '[]', 'null', '{"mcpServers": []}']) {
    fs.writeFileSync(file, original);
    assert.throws(() => mergeJsonConfig(file, {}));
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('private writes reject symbolic links', { skip: process.platform === 'win32' }, (t) => {
  const dir = scratch(t);
  const real = path.join(dir, 'real');
  fs.writeFileSync(real, 'preserved');
  const link = path.join(dir, 'link');
  fs.symlinkSync(real, link);
  assert.throws(() => privateWrite(link, 'replacement'));
  assert.equal(fs.readFileSync(real, 'utf8'), 'preserved');
});

test('client paths use the editable WorkBuddy file and supported Claude location', () => {
  assert.equal(clientConfigPath('workbuddy', '/home/test'), path.join('/home/test', '.workbuddy/mcp.json'));
  assert.equal(clientConfigPath('claude', '/home/test', 'darwin'), path.join('/home/test', 'Library/Application Support/Claude/claude_desktop_config.json'));
});

test('installer and installed launcher complete real MCP handshake against a fixture backend', { timeout: 120000 }, async (t) => {
  const home = scratch(t);
  const secret = 'fixture-only-secret-DO-NOT-PRINT';
  let rejectLogin = false;
  let reads = 0;
  const backend = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/collections/_superusers/auth-with-password') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const auth = JSON.parse(body);
      if (rejectLogin || auth.identity !== 'agent@test.local' || auth.password !== secret) {
        res.writeHead(400).end(JSON.stringify({ message: secret }));
      } else res.end(JSON.stringify({ token: 'fixture-token' }));
    } else if (req.url.startsWith('/api/collections/activities/records') && req.headers.authorization === 'fixture-token') {
      reads++;
      res.end(JSON.stringify({ items: [] }));
    } else res.writeHead(403).end('{}');
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => backend.close(resolve)));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    CC_PB_URL: `http://127.0.0.1:${backend.address().port}`, CC_AGENT_EMAIL: 'agent@test.local', CC_AGENT_PASSWORD: secret };
  const installDir = path.join(home, 'stable runtime');
  const installer = fileURLToPath(new URL('./install.mjs', import.meta.url));
  const args = [installer, '--client', 'workbuddy', '--install-dir', installDir];
  const configFile = path.join(home, '.workbuddy/mcp.json');
  privateWrite(configFile, '{"mcpServers":{"unrelated":{"command":"keep"}}}');
  rejectLogin = true;
  let result = await execute(process.execPath, args, env);
  assert.notEqual(result.code, 0);
  assert.ok(!result.output.includes(secret));
  assert.equal(JSON.parse(fs.readFileSync(configFile)).mcpServers.chatcircle, undefined);
  assert.ok(!fs.existsSync(path.join(installDir, 'credentials.json')));
  rejectLogin = false;
  result = await execute(process.execPath, args, env);
  assert.equal(result.code, 0, result.output);
  assert.ok(!result.output.includes(secret));
  assert.ok(reads > 0);
  const config = JSON.parse(fs.readFileSync(configFile));
  assert.equal(config.mcpServers.unrelated.command, 'keep');
  assert.equal(config.mcpServers.chatcircle.command, process.execPath);
  assert.ok(!fs.readFileSync(configFile, 'utf8').includes(secret));
  const credentialsFile = path.join(installDir, 'credentials.json');
  if (process.platform !== 'win32') assert.equal(fs.statSync(credentialsFile).mode & 0o777, 0o600);

  const cleanEnv = { ...env };
  for (const key of ['CC_AGENT_EMAIL', 'CC_AGENT_PASSWORD', 'CC_PB_URL']) delete cleanEnv[key];
  const client = new Client({ name: 'installer-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ ...config.mcpServers.chatcircle, env: cleanEnv, stderr: 'pipe' });
  transport.stderr.resume();
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 3);
    assert.ok(!(await client.callTool({ name: 'list_activities', arguments: { limit: 1 } })).isError);
  } finally { await client.close(); }

  // Switching backends must not silently send a previously saved password.
  result = await execute(process.execPath, [...args, '--url', 'http://localhost:8090'], cleanEnv);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /非交互安装缺少参数/);

  const savedData = path.join(installDir, 'data', 'existing-report.md');
  fs.writeFileSync(savedData, 'preserve report');
  // Reinstallation reuses saved credentials without prompting or duplicate registration.
  result = await execute(process.execPath, args, cleanEnv);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), config);
  assert.equal(fs.readFileSync(savedData, 'utf8'), 'preserve report');

  // Real Codex registration in an isolated profile, when CLI is available locally.
  if (spawnSync('codex', ['mcp', 'add', '--help'], { stdio: 'ignore' }).status === 0) {
    privateWrite(path.join(env.CODEX_HOME, 'config.toml'), 'model = "retained-model"\n[mcp_servers.other]\ncommand = "keep"\n');
    result = await execute(process.execPath, [installer, '--client', 'codex', '--install-dir', installDir], cleanEnv);
    assert.equal(result.code, 0, result.output);
    const toml = fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.match(toml, /retained-model/);
    assert.match(toml, /mcp_servers\.other/);
    assert.match(toml, /mcp_servers\.chatcircle/);
    assert.ok(!toml.includes(secret));
  } else t.diagnostic('Codex CLI unavailable; live Codex config integration skipped.');

  rejectLogin = true;
  const previousCredentials = fs.readFileSync(credentialsFile, 'utf8');
  result = await execute(process.execPath, args, env);
  assert.notEqual(result.code, 0);
  assert.ok(!result.output.includes(secret));
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), config);
  assert.equal(fs.readFileSync(credentialsFile, 'utf8'), previousCredentials);
});
