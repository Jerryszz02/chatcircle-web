import fs from 'node:fs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { privateWrite, validateUrl } from './local-config.mjs';

const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export class LoginRequiredError extends Error {
  constructor(url) {
    super(JSON.stringify({ code: 'LOGIN_REQUIRED', login_url: url,
      message: '请在浏览器打开登录链接，用现有 Chat Circles 超级管理员账号登录，然后重试当前操作。不要在聊天中提供密码。' }));
  }
}

export function createAuth({ pbUrl, sessionFile, loginTimeoutMs = 10 * 60 * 1000 }) {
  pbUrl = validateUrl(pbUrl);
  let token = null;
  let authenticating = null;
  let loginPage = null;
  let opening = null;
  let timer = null;

  function readSession() {
    try {
      const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      return session.pbUrl === pbUrl && typeof session.token === 'string' ? session.token : null;
    } catch { return null; }
  }
  function saveSession(data) {
    if (typeof data.token !== 'string' || !data.token || data.record?.collectionName !== '_superusers') {
      throw new Error('登录响应无效，请使用超级管理员账号。');
    }
    privateWrite(sessionFile, JSON.stringify({ pbUrl, token: data.token }) + '\n');
    token = data.token;
  }
  function invalidate() {
    token = null;
    if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
  }
  function closeLogin() {
    clearTimeout(timer);
    loginPage?.server.close();
    loginPage?.server.closeIdleConnections?.();
    loginPage = null;
  }
  async function authenticate(route, options) {
    return fetch(`${pbUrl}/api/collections/_superusers/${route}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), ...options,
    });
  }

  async function openLogin() {
    if (loginPage) return loginPage.url;
    if (opening) return opening;
    opening = (async () => {
      const route = `/login/${randomBytes(32).toString('hex')}`;
      let origin;
      let busy = false;
      const server = http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        // Keep same-origin POST Origin intact; no-referrer makes Chrome send Origin: null.
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
        const reply = (status, text, html = false) => {
          res.writeHead(status, { 'Content-Type': `${html ? 'text/html' : 'text/plain'}; charset=utf-8` });
          res.end(text);
        };
        if (req.headers.host !== new URL(origin).host || req.url !== route) return reply(404, '页面不存在或已过期。');
        if (req.method === 'GET') {
          return reply(200, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 Chat Circles MCP</title>
<style>body{font:16px/1.6 system-ui,sans-serif;background:#f5f7fa;color:#152b45;padding:24px}main{max-width:440px;margin:8vh auto;background:white;padding:32px;border-radius:16px}h1{font-size:25px}label{display:block;margin:20px 0 6px}input,button{box-sizing:border-box;width:100%;font:inherit;padding:12px;border:1px solid #8797aa;border-radius:6px}button{margin-top:24px;background:#163957;color:white;cursor:pointer}small{color:#465a70;overflow-wrap:anywhere}</style>
<main><h1>登录 Chat Circles</h1><p>使用你现有的超级管理员账号。登录完成后，返回对话重试刚才的操作。</p><small>连接的网站：${escapeHtml(pbUrl)}</small>
<form method="post" action="${route}"><label for="identity">邮箱</label><input id="identity" name="identity" type="email" autocomplete="username" required><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">登录并连接</button></form><p><small>密码仅用于本次登录，不保存到本机，也不发送到对话。此页面 10 分钟后失效。</small></p></main></html>`, true);
        }
        if (req.method !== 'POST') return reply(405, '不支持此请求。');
        if (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
          return reply(403, '请从本机登录页面提交。');
        }
        if (busy) return reply(429, '正在登录，请稍后重试。');
        busy = true;
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 16384) { reply(413, '输入内容过长。'); return; }
            chunks.push(chunk);
          }
          const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          const identity = form.get('identity')?.trim();
          const password = form.get('password');
          if (!identity || !password) return reply(400, '请输入邮箱和密码，返回上一页后重试。');
          const response = await authenticate('auth-with-password', {
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity, password }),
          });
          if (!response.ok) return reply(response.status === 429 ? 429 : 401, '登录未成功，请检查账号密码或稍后重试。返回上一页可重新输入。');
          saveSession(await response.json());
          reply(200, '登录成功。可以关闭此页面，返回对话重试刚才的操作。');
          closeLogin();
        } catch {
          reply(502, '暂时无法完成登录，请检查网络或后端设置，返回上一页后重试。');
        } finally { busy = false; }
      });
      server.requestTimeout = 20000;
      server.headersTimeout = 10000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      origin = `http://127.0.0.1:${server.address().port}`;
      loginPage = { server, url: `${origin}${route}` };
      server.unref();
      timer = setTimeout(closeLogin, loginTimeoutMs);
      timer.unref();
      return loginPage.url;
    })();
    try { return await opening; } finally { opening = null; }
  }
  async function requireLogin() {
    throw new LoginRequiredError(await openLogin());
  }
  async function ensure() {
    if (authenticating) return authenticating;
    authenticating = (async () => {
      // Reload on demand so another client on this machine can finish login for us.
      token = readSession();
      if (!token) return requireLogin();
      let response;
      try { response = await authenticate('auth-refresh', { headers: { Authorization: token } }); }
      catch { throw new Error('暂时无法验证登录状态，请检查后端连接后重试。'); }
      if ([400, 401, 403].includes(response.status)) {
        invalidate();
        return requireLogin();
      }
      if (!response.ok) throw new Error('暂时无法验证登录状态，请稍后重试。');
      saveSession(await response.json());
      return token;
    })();
    try { return await authenticating; } finally { authenticating = null; }
  }
  return { ensure, invalidate, requireLogin, close: closeLogin };
}
