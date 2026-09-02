#!/usr/bin/env node

/**
 * T7 发布配置的无密钥静态验证。
 *
 * 这里只检查能由仓库证据确定的不变量：生产短信 provider、必填环境变量占位、
 * 隐私版本一致性、TLS/安全头、PocketBase 管理台封闭和部署预检。它不读取 .env，
 * 也不能代替真实阿里云、微信内置浏览器、备份恢复或线上健康检查。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

export function hasActiveAdminConsoleBlock(caddyfile) {
  const activeConfig = caddyfile.replace(/^\s*#.*$/gm, '');
  return /\bhandle\s+\/_\/\*\s*\{[^{}]*\brespond\s+403(?:\s|$)[^{}]*\}/m.test(activeConfig);
}

const files = {
  compose: read('docker-compose.yml'),
  envExample: read('.env.example'),
  caddy: read('deploy/Caddyfile'),
  deployWorkflow: read('.github/workflows/deploy.yml'),
  phoneHook: read('backend/pb_hooks/phoneauth.pb.js'),
  phoneUi: read('frontend/src/features/participant/lib/phone.ts'),
  gitignore: read('.gitignore'),
};

const failures = [];
const checks = [];

function check(name, condition, detail) {
  checks.push(name);
  if (!condition) failures.push(`${name}: ${detail}`);
}

const requiredComposeVariables = [
  ...files.compose.matchAll(/\$\{([A-Z0-9_]+):\?[^}]+\}/g),
].map((match) => match[1]);

check(
  '必填部署变量均在 .env.example 留有占位',
  requiredComposeVariables.every((name) => new RegExp(`^#?\\s*${name}=`, 'm').test(files.envExample)),
  `缺少：${requiredComposeVariables.filter((name) => !new RegExp(`^#?\\s*${name}=`, 'm').test(files.envExample)).join(', ')}`,
);

check(
  '生产环境禁用 mock 短信',
  files.compose.includes('CC_ENVIRONMENT: ${CC_ENVIRONMENT:-production}')
    && files.compose.includes('CC_SMS_PROVIDER: ${CC_SMS_PROVIDER:-aliyun}')
    && !files.compose.includes('CC_SMS_MOCK_CODE:'),
  'compose 必须默认 production + aliyun，且不得注入 mock 验证码',
);

const privacyVersion = '2026-08-28.v1';
check(
  '前端、后端与部署的隐私版本一致',
  files.phoneUi.includes(`PARTICIPANT_PRIVACY_NOTICE_VERSION = '${privacyVersion}'`)
    && files.phoneHook.includes(`|| '${privacyVersion}'`)
    && files.compose.includes(`CC_PARTICIPANT_PRIVACY_NOTICE_VERSION:-${privacyVersion}`),
  `三处必须统一为 ${privacyVersion}`,
);

check(
  '应用端口只绑定回环地址',
  files.compose.includes("'127.0.0.1:8090:8090'") && !files.compose.includes("'8090:8090'"),
  'PocketBase 8090 不得直接暴露到公网',
);

for (const [name, expected] of [
  ['HSTS', 'Strict-Transport-Security'],
  ['CSP', 'Content-Security-Policy'],
  ['防 MIME 嗅探', 'X-Content-Type-Options'],
  ['防嵌入', 'X-Frame-Options'],
  ['可信代理源 IP', 'header_up X-Forwarded-For {remote_host}'],
]) {
  check(`Caddy ${name}`, files.caddy.includes(expected), `缺少 ${expected}`);
}

check(
  'Caddy PB 管理台封闭',
  hasActiveAdminConsoleBlock(files.caddy),
  '缺少活动的 handle /_/* { respond 403 } 配置块',
);

for (const [name, expected] of [
  ['Compose 配置预检', 'docker compose config -q'],
  ['候选镜像构建', 'build'],
  ['手机号 HMAC 密钥长度校验', '${#CC_PHONE_HASH_KEY}'],
  ['部署后健康检查', 'curl -fsS http://127.0.0.1:8090/api/health'],
]) {
  check(`部署 workflow ${name}`, files.deployWorkflow.includes(expected), `缺少 ${expected}`);
}

check(
  '.env 被 Git 忽略',
  /(^|\n)\.env(\n|$)/.test(files.gitignore),
  '必须防止真实部署密钥进入仓库',
);

if (failures.length > 0) {
  console.error(`[T7 release-config] FAIL (${failures.length}/${checks.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[T7 release-config] PASS (${checks.length}/${checks.length})`);
console.log(`required env placeholders: ${[...new Set(requiredComposeVariables)].sort().join(', ')}`);
