#!/usr/bin/env node

/**
 * T7 发布配置的无密钥静态验证。
 *
 * 这里只检查能由仓库证据确定的不变量：生产短信 provider、必填环境变量占位、
 * 隐私版本一致性、标准 80/443 Automatic HTTPS、安全头、PocketBase 管理台封闭和部署预检。
 * 它不读取 .env，也不能代替真实阿里云、微信内置浏览器、备份恢复或线上健康检查。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hasActiveAdminConsoleBlock,
  hasActiveConfigText,
  hasCandidateImagePreflightBuild,
  hasCandidateBackupRuntimeSmoke,
  hasCandidatePublicWebSmoke,
  hasBackupPostDeployHealthCheck,
  hasBackupPreDeployReadiness,
  hasBackupRevisionBinding,
  hasBuiltBackupRuntime,
  hasBuiltPublicWebRuntime,
  hasFunctionalSpaNoindex,
  hasIsolatedPublicWebService,
  hasPostDeployPublicWebGate,
  hasPublicWebCaddyRouting,
  hasPublicWebPostDeployHealthCheck,
  hasPublicWebUpstreamConfig,
  hasRegisterBeforePublicActivity,
  hasSerializedBackupGateBeforeSwitch,
  hasLoopbackOnlyPocketBasePort,
  hasPostDeployHealthCheck,
  hasCiSuccessGate,
  hasImmutableDeploySha,
  hasManualShaCiValidation,
  hasPreflightComposeValidation,
  hasPreflightPhoneKeyValidation,
  hasPreflightSmsValidation,
  hasRuntimeImagePreflightPull,
  hasStandardCaddyPublicPorts,
  hasXffOverrideOnAllUpstreams,
  rejectsLegacyServerOverride,
  stripConfigComments,
  usesStandardAutomaticHttps,
} from './release-config-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const files = {
  compose: read('docker-compose.yml'),
  envExample: read('.env.example'),
  caddy: read('deploy/Caddyfile'),
  deployWorkflow: read('.github/workflows/deploy.yml'),
  backupDockerfile: read('deploy/backup.Dockerfile'),
  publicWebDockerfile: read('deploy/public-web.Dockerfile'),
  phoneHook: read('backend/pb_hooks/phoneauth.pb.js'),
  phoneUi: read('frontend/src/features/participant/lib/phone.ts'),
  gitignore: read('.gitignore'),
};

const failures = [];
const checks = [];
const activeCompose = stripConfigComments(files.compose);
const activeCaddy = stripConfigComments(files.caddy);
const activeEnvExample = stripConfigComments(files.envExample);

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

const privacyVersion = '2026-09-05.v1';
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

check(
  'backup 使用提交绑定的构建镜像',
  hasBuiltBackupRuntime(files.compose)
    && /ARG CC_RELEASE_SHA/.test(files.backupDockerfile)
    && /LABEL org\.opencontainers\.image\.revision/.test(files.backupDockerfile)
    && /timeout -s KILL 120 apk add --no-cache tzdata flock/.test(files.backupDockerfile)
    && /CMD \["crond", "-f", "-d", "8"\]/.test(files.backupDockerfile),
  'backup 必须在构建期安装依赖、复制脚本并以前台 crond 启动，禁止运行时 apk 安装',
);

check(
  'public-web 使用提交绑定的构建镜像',
  hasBuiltPublicWebRuntime(files.compose)
    && /ARG CC_RELEASE_SHA/.test(files.publicWebDockerfile)
    && /LABEL org\.opencontainers\.image\.revision/.test(files.publicWebDockerfile)
    && /CMD \["node", "dist-public\/server\/index\.js"\]/.test(files.publicWebDockerfile),
  'public-web 必须由 deploy/public-web.Dockerfile 构建、以 CC_RELEASE_SHA 标记并运行渲染服务 bundle',
);

check(
  'public-web 不发布 host 端口、不挂卷',
  hasIsolatedPublicWebService(files.compose),
  '公开渲染服务只允许经 Docker 私网被 Caddy 访问，不得发布 host 端口或挂载 pb_data',
);

check(
  'public-web 上游与站点 origin 配置',
  hasPublicWebUpstreamConfig(files.compose),
  'CC_PB_INTERNAL_URL 必须指向 app:8090，CC_SITE_ORIGIN 默认 https://chatcircle.empact.cn',
);

check(
  'Caddy 使用标准 80/443',
  hasStandardCaddyPublicPorts(files.compose),
  '生产 Caddy 必须发布 80:80 与 443:443，且不得保留 8443',
);

check(
  'Caddy 使用标准 Automatic HTTPS',
  usesStandardAutomaticHttps(files.caddy),
  '站点必须为 chatcircle.empact.cn，且不得保留 :8443、dns alidns 或 ALIYUN_ACCESS_KEY_*',
);

check(
  '旧 DNS-01 凭据不再属于生产配置',
  !activeCompose.includes('ALIYUN_ACCESS_KEY_ID')
    && !activeCompose.includes('ALIYUN_ACCESS_KEY_SECRET')
    && !activeCaddy.includes('ALIYUN_ACCESS_KEY_ID')
    && !activeCaddy.includes('ALIYUN_ACCESS_KEY_SECRET')
    && !activeEnvExample.includes('ALIYUN_ACCESS_KEY_ID=')
    && !activeEnvExample.includes('ALIYUN_ACCESS_KEY_SECRET='),
  'ICP备案后的正式部署不得重新依赖 Caddy DNS-01 AccessKey',
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
  'Caddy 公开页 SSR 路由',
  hasPublicWebCaddyRouting(files.caddy),
  '缺少 /public-assets、robots.txt、sitemap.xml 或公开页路径到 public-web:3100 的路由（含兜底 404）',
);

check(
  'Caddy 功能 SPA 路径 noindex',
  hasFunctionalSpaNoindex(files.caddy),
  '功能 SPA 路径组必须完整（登录/我的/培训/签到/问卷/管理端/报名），带 header X-Robots-Tag "noindex" 并反代 app:8090',
);

check(
  'Caddy 报名路由先于公开活动详情',
  hasRegisterBeforePublicActivity(files.caddy),
  '/a/*/register（功能页）必须在 /a/*（公开页）之前命中，否则报名页会被 SSR 404',
);

check(
  'Caddy 全部上游覆盖 XFF',
  hasXffOverrideOnAllUpstreams(files.caddy),
  'app:8090 与 public-web:3100 每个 reverse_proxy 块都必须覆盖 X-Forwarded-For',
);

check(
  '部署 workflow 拒绝 legacy server override',
  rejectsLegacyServerOverride(files.deployWorkflow),
  '预检步骤必须在检测到 /opt/chatcircle/docker-compose.override.yml 时失败',
);

check(
  '部署 workflow Compose 配置预检',
  hasPreflightComposeValidation(files.deployWorkflow),
  '预检步骤缺少活动的 docker compose config -q',
);

check(
  '部署 workflow 仅接受 CI 成功提交',
  hasCiSuccessGate(files.deployWorkflow),
  '部署必须等待固定提交的 CI 成功运行，并由 verify-ci job gate 保证',
);

check(
  '预检、构建和部署使用不可变提交 SHA',
  hasImmutableDeploySha(files.deployWorkflow),
  '预检 worktree、构建输入和生产切换必须使用同一个固定 SHA',
);

check(
  '手动部署验证同一 SHA 的 CI 成功',
  hasManualShaCiValidation(files.deployWorkflow),
  'workflow_dispatch 必须要求完整 SHA，并查询该 SHA 的成功 CI 运行',
);

check(
  '部署 workflow 运行时镜像预拉取',
  hasRuntimeImagePreflightPull(files.deployWorkflow),
  '预检步骤必须只预拉取 image-only 的 caddy；backup 由候选提交构建',
);

check(
  '部署 workflow 候选镜像构建',
  hasCandidateImagePreflightBuild(files.deployWorkflow),
  '预检步骤缺少活动的 docker compose --project-name "$preflight_project" build',
);

check(
  '部署预检候选 backup 无网络启动 smoke',
  hasCandidateBackupRuntimeSmoke(files.deployWorkflow),
  '候选 backup 镜像构建后必须运行 deploy/smoke-backup-runtime.sh，避免仅凭 build 放行',
);

check(
  '部署预检候选 public-web 无网络启动 smoke',
  hasCandidatePublicWebSmoke(files.deployWorkflow),
  '候选 public-web 镜像构建后必须运行 deploy/smoke-public-web-runtime.sh，避免仅凭 build 放行',
);

check(
  '部署 workflow 手机号 HMAC 密钥长度校验',
  hasPreflightPhoneKeyValidation(files.deployWorkflow),
  '预检步骤缺少活动的 CC_PHONE_HASH_KEY 长度检查',
);

const smsTemplateVars = [
  'CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE',
  'CC_SMS_TEMPLATE_BIND_NEW_CODE',
  'CC_SMS_TEMPLATE_VERIFY_BOUND_CODE',
];

check(
  'app 容器注入三个场景短信模板变量',
  smsTemplateVars.every((name) => activeCompose.includes(`${name}: \${${name}:-}`)),
  `缺少：${smsTemplateVars.filter((name) => !activeCompose.includes(`${name}: \${${name}:-}`)).join(', ')}`,
);

check(
  '三个场景短信模板变量在 .env.example 留有占位',
  smsTemplateVars.every((name) => new RegExp(`^#?\\s*${name}=`, 'm').test(files.envExample)),
  `缺少：${smsTemplateVars.filter((name) => !new RegExp(`^#?\\s*${name}=`, 'm').test(files.envExample)).join(', ')}`,
);

check(
  '部署 workflow 生产短信必填变量预检',
  hasPreflightSmsValidation(files.deployWorkflow),
  '预检步骤缺少对生产短信全部必填变量的检查（ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET、CC_SMS_SIGN_NAME 与三个模板 CODE）',
);

check(
  '部署 workflow 部署后容器健康检查',
  hasPostDeployHealthCheck(files.deployWorkflow),
  '生产更新步骤缺少活动的容器健康检查（docker compose ps -q app + docker inspect State.Health.Status）',
);

check(
  '切换前 backup 锁门禁与就绪等待',
  hasBackupPreDeployReadiness(files.deployWorkflow)
    && hasSerializedBackupGateBeforeSwitch(files.deployWorkflow),
  '切换生产提交前必须有有限时的 backup runtime 就绪检查，并执行成功备份',
);

check(
  '部署后 backup 容器健康检查',
  hasBackupPostDeployHealthCheck(files.deployWorkflow),
  '生产更新后必须等待 backup healthcheck healthy，并在失败时输出诊断',
);

check(
  '部署后 backup 镜像绑定目标 SHA',
  hasBackupRevisionBinding(files.deployWorkflow),
  '生产更新后必须确认 backup OCI revision 与目标提交一致',
);

check(
  '部署后 public-web 容器健康检查',
  hasPublicWebPostDeployHealthCheck(files.deployWorkflow),
  '生产更新后必须等待 public-web healthcheck healthy，并在失败时输出诊断',
);

check(
  '部署后公开页 SSR 门禁',
  hasPostDeployPublicWebGate(files.deployWorkflow),
  '上线后必须校验首页原始 HTML 的 canonical/__CC_PUBLIC_DATA__ 标记与 robots.txt 的 Sitemap 行',
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
