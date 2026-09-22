import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAuth, LoginRequiredError } from './auth.mjs';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-auth-'));
  const state = { requests: 0, logins: 0, reads: 0, refreshes: 0, revoked: false, unavailable: false, rejectData: false };
  const backend = http.createServer(async (req, res) => {
    state.requests++;
    res.setHeader('Content-Type', 'application/json');
    if (state.unavailable) return res.writeHead(503).end('{}');
    if (req.url.endsWith('/auth-with-password')) {
      state.logins++;
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      if (input.identity !== 'existing@example.com' || input.password !== 'test-only-password') {
        return res.writeHead(400).end(JSON.stringify({ message: 'sensitive upstream response' }));
      }
      state.revoked = false;
      return res.end(JSON.stringify({ token: 'test-session-token', record: { collectionName: '_superusers' } }));
    }
    if (req.headers.authorization !== 'test-session-token' || state.revoked) return res.writeHead(401).end('{}');
    if (req.url.endsWith('/auth-refresh')) {
      state.refreshes++;
      return res.end(JSON.stringify({ token: 'test-session-token', record: { collectionName: '_superusers' } }));
    }
    if (state.rejectData) return res.writeHead(401).end('{}');
    if (req.url.startsWith('/api/collections/activities/records')) {
      state.reads++;
      return res.end(JSON.stringify({ items: [] }));
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { state, dir, pbUrl: `http://127.0.0.1:${backend.address().port}`, sessionFile: path.join(dir, 'session.json') };
}
async function loginUrl(auth) {
  try { await auth.ensure(); assert.fail('Expected login'); }
  catch (error) { assert.ok(error instanceof LoginRequiredError); return JSON.parse(error.message).login_url; }
}
function post(url, overrides = {}) {
  return fetch(url, { method: 'POST', headers: { Origin: new URL(url).origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ identity: 'existing@example.com', password: 'test-only-password' }), ...overrides });
}

test('first use returns guarded login page; only token persists and restart reuses session', async (t) => {
  const context = await fixture(t);
  const auth = createAuth(context);
  t.after(auth.close);
  const [url, sameUrl] = await Promise.all([loginUrl(auth), loginUrl(auth)]);
  assert.equal(url, sameUrl);
  assert.equal(context.state.requests, 0);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /type="password"/);
  assert.equal((await fetch(new URL('/wrong', url))).status, 404);
  const hostileHost = await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Host: 'attacker.invalid' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(hostileHost, 404);
  assert.equal((await post(url, { headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 403);
  assert.equal((await post(url, { headers: { Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 403);
  assert.equal(context.state.logins, 0);
  const bad = await post(url, { body: new URLSearchParams({ identity: 'existing@example.com', password: 'wrong' }) });
  assert.equal(bad.status, 401);
  assert.ok(!(await bad.text()).includes('sensitive upstream response'));
  assert.ok(!fs.existsSync(context.sessionFile));
  assert.equal((await post(url)).status, 200);
  const saved = fs.readFileSync(context.sessionFile, 'utf8');
  assert.ok(!saved.includes('test-only-password'));
  assert.ok(!saved.includes('existing@example.com'));
  assert.deepEqual(JSON.parse(saved), { pbUrl: context.pbUrl, token: 'test-session-token' });
  if (process.platform !== 'win32') assert.equal(fs.statSync(context.sessionFile).mode & 0o777, 0o600);
  assert.equal(await auth.ensure(), 'test-session-token');
  const restarted = createAuth(context);
  t.after(restarted.close);
  assert.equal(await restarted.ensure(), 'test-session-token');
  assert.equal(context.state.logins, 2); // one rejected password and one successful login
  context.state.unavailable = true;
  await assert.rejects(restarted.ensure(), /暂时无法验证/);
  assert.ok(fs.existsSync(context.sessionFile));
  context.state.unavailable = false;
  context.state.revoked = true;
  assert.match(await loginUrl(restarted), /^http:\/\/127\.0\.0\.1:/);
  assert.ok(!fs.existsSync(context.sessionFile));
});

test('login URLs expire, oversized submissions are rejected, and sessions are backend-bound', async (t) => {
  const context = await fixture(t);
  const auth = createAuth({ ...context, loginTimeoutMs: 100 });
  t.after(auth.close);
  const url = await loginUrl(auth);
  assert.equal((await post(url, { body: 'x'.repeat(17000) })).status, 413);
  assert.equal(context.state.logins, 0);
  await new Promise((resolve) => setTimeout(resolve, 130));
  await assert.rejects(fetch(url));
  const next = await loginUrl(auth);
  assert.notEqual(next, url);
  fs.writeFileSync(context.sessionFile, JSON.stringify({ pbUrl: 'https://different.example', token: 'do-not-send' }));
  await loginUrl(auth);
  assert.equal(context.state.requests, 0);
});

test('MCP connects without login; after browser login the same process reads data and 401 requests login again', async (t) => {
  const context = await fixture(t);
  const client = new Client({ name: 'auth-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./server.js', import.meta.url))],
    env: { ...process.env, CC_PB_URL: context.pbUrl, CC_SESSION_FILE: context.sessionFile, CC_DATA_DIR: path.join(context.dir, 'data') }, stderr: 'pipe' });
  let logs = '';
  transport.stderr.on('data', (chunk) => { logs += chunk; });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 3);
    assert.equal(context.state.requests, 0);
    const call = () => client.callTool({ name: 'list_activities', arguments: { limit: 1 } });
    const first = await call();
    assert.equal(first.isError, true);
    const required = JSON.parse(first.content[0].text);
    assert.equal(required.code, 'LOGIN_REQUIRED');
    assert.equal(context.state.reads, 0);
    assert.equal((await post(required.login_url)).status, 200);
    assert.ok(!(await call()).isError);
    assert.equal(context.state.reads, 1);
    context.state.rejectData = true;
    const expired = await call();
    assert.equal(expired.isError, true);
    assert.equal(JSON.parse(expired.content[0].text).code, 'LOGIN_REQUIRED');
    assert.ok(!fs.existsSync(context.sessionFile));
    assert.ok(!logs.includes('test-session-token'));
    assert.ok(!logs.includes('test-only-password'));
  } finally { await client.close(); }
});
