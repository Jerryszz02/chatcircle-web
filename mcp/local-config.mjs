import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_PB_URL = 'https://chatcircle.empact.cn';

export function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('后端地址必须是有效的 HTTP(S) URL。'); }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('后端地址不能包含账号、密码、查询参数或片段。');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('远程后端必须使用 HTTPS；HTTP 仅允许本机回环地址。');
  }
  return url.href.replace(/\/+$/, '');
}

export function privateWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('拒绝写入符号链接配置。');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    try { fs.writeFileSync(descriptor, content); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
