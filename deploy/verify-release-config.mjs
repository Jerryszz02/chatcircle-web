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

import {
  hasActiveAdminConsoleBlock,
  hasActiveConfigText,
  hasCandidateImagePreflightBuild,
  hasLoopbackOnlyPocketBasePort,
  hasPostDeployHealthCheck,
  hasPreflightComposeValidation,
  hasPreflightPhoneKeyValidation,
  stripConfigComments,
} from './release-config-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

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
const activeCompose = stripConfigComments(files.compose);

function check(name, condition, detail) {
  checks.push(name);
  if (!condition) failures.push(`${name}: ${detail}`);
}

const requiredComposeVariables = [
  ...activeCompose.matchAll(/\$\{([A-Z0-9_]+):\?[^}]+\}/g),
].map((match) => match[1]);

check(
  '必填部署变量均在 .env.example 留有占位',
  requiredComposeVariables.every((name) => new RegExp(`^#?\\s*${name}=`, 'm').test(files.envExample)),
  `缺少：${requiredComposeVariables.filter((name) => !new RegExp(`^#?\\s*${name}=`, 'm').test(files.envExample)).join(', ')}`,
);

check(
  '生产环境禁用 mock 短信',
  activeCompose.includes('CC_ENVIRONMENT: ${CC_ENVIRONMENT:-production}')
    && activeCompose.includes('CC_SMS_PROVIDER: ${CC_SMS_PROVIDER:-aliyun}')
    && !activeCompose.includes('CC_SMS_MOCK_CODE:'),
  'compose 必须默认 production + aliyun，且不得注入 mock 验证码',
);

const privacyVersion = '2026-08-28.v1';
check(
  '前端、后端与部署的隐私版本一致',
  new RegExp(`^export const PARTICIPANT_PRIVACY_NOTICE_VERSION = '${privacyVersion}';$`, 'm').test(files.phoneUi)
    && new RegExp(`^\\s*const PRIVACY_NOTICE_VERSION = .*\\|\\| '${privacyVersion}';$`, 'm').test(files.phoneHook)
    && activeCompose.includes(`CC_PARTICIPANT_PRIVACY_NOTICE_VERSION:-${privacyVersion}`),
  `三处必须统一为 ${privacyVersion}`,
);

check(
  '应用端口只绑定回环地址',
  hasLoopbackOnlyPocketBasePort(files.compose),
  'PocketBase 8090 不得直接暴露到公网',
);

for (const [name, expected] of [
  ['HSTS', 'Strict-Transport-Security'],
  ['CSP', 'Content-Security-Policy'],
  ['防 MIME 嗅探', 'X-Content-Type-Options'],
  ['防嵌入', 'X-Frame-Options'],
  ['可信代理源 IP', 'header_up X-Forwarded-For {remote_host}'],
]) {
  check(`Caddy ${name}`, hasActiveConfigText(files.caddy, expected), `缺少活动的 ${expected}`);
}

check(
  'Caddy PB 管理台封闭',
  hasActiveAdminConsoleBlock(files.caddy),
  '缺少活动的 handle /_/* { respond 403 } 配置块',
);

check(
  '部署 workflow Compose 配置预检',
  hasPreflightComposeValidation(files.deployWorkflow),
  '预检步骤缺少活动的 docker compose config -q',
);

check(
  '部署 workflow 候选镜像构建',
  hasCandidateImagePreflightBuild(files.deployWorkflow),
  '预检步骤缺少活动的 docker compose --project-name "$preflight_project" build',
);

check(
  '部署 workflow 手机号 HMAC 密钥长度校验',
  hasPreflightPhoneKeyValidation(files.deployWorkflow),
  '预检步骤缺少活动的 CC_PHONE_HASH_KEY 长度检查',
);

check(
  '部署 workflow 部署后健康检查',
  hasPostDeployHealthCheck(files.deployWorkflow),
  '生产更新步骤缺少活动的 /api/health 检查',
);

check(
  '.env 被 Git 忽略',
  /(^|\n)\.env(\n|$)/.test(stripConfigComments(files.gitignore)),
  '必须防止真实部署密钥进入仓库',
);

if (failures.length > 0) {
  console.error(`[T7 release-config] FAIL (${failures.length}/${checks.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[T7 release-config] PASS (${checks.length}/${checks.length})`);
console.log(`required env placeholders: ${[...new Set(requiredComposeVariables)].sort().join(', ')}`);
