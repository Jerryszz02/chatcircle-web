function stripLineComment(line) {
  let singleQuoted = false;
  let doubleQuoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const previous = index > 0 ? line[index - 1] : '';

    if (character === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
    if (character === '"' && !singleQuoted && previous !== '\\') doubleQuoted = !doubleQuoted;

    if (character === '#' && !singleQuoted && !doubleQuoted && (index === 0 || /\s/.test(previous))) {
      return line.slice(0, index);
    }
  }

  return line;
}

export function stripConfigComments(content) {
  return content
    .split('\n')
    .map(stripLineComment)
    .join('\n');
}

export function hasActiveConfigText(content, expected) {
  return stripConfigComments(content).includes(expected);
}

export function hasActiveAdminConsoleBlock(caddyfile) {
  const activeConfig = stripConfigComments(caddyfile);
  return /\bhandle\s+\/_\/\*\s*\{[^{}]*\brespond\s+403(?:\s|$)[^{}]*\}/m.test(activeConfig);
}

function shortPortMappings(compose) {
  const activeCompose = stripConfigComments(compose);
  return [...activeCompose.matchAll(/^\s*-\s*(?:'([^']+)'|"([^"]+)"|([^\s]+))\s*$/gm)]
    .map((match) => match[1] || match[2] || match[3]);
}

export function hasLoopbackOnlyPocketBasePort(compose) {
  const mappings = shortPortMappings(compose)
    .filter((mapping) => /(^|:)8090(?:\/tcp)?$/.test(mapping));

  // 无 8090 映射（生产默认不向 host 发布 PocketBase 端口，仅在 Docker 私网供 Caddy/backup
  // 访问 —— 2026-09 安全加固）同样满足「不得暴露到公网」；有映射则必须全部只绑 127.0.0.1。
  return mappings.length === 0
    || mappings.every((mapping) => /^127\.0\.0\.1:\d+:8090(?:\/tcp)?$/.test(mapping));
}

export function hasBuiltBackupRuntime(compose) {
  const active = stripConfigComments(compose);
  return /image:\s+chatcircle-backup:\$\{CC_RELEASE_SHA:-local\}/.test(active)
    && /context:\s+\.\/deploy/.test(active)
    && /dockerfile:\s+backup\.Dockerfile/.test(active)
    && !/apk add[^\n]*tzdata[^\n]*flock/.test(active);
}

export function hasStandardCaddyPublicPorts(compose) {
  const mappings = shortPortMappings(compose);
  const has80 = mappings.some((mapping) => /^(?:0\.0\.0\.0:)?80:80(?:\/tcp)?$/.test(mapping));
  const has443 = mappings.some((mapping) => /^(?:0\.0\.0\.0:)?443:443(?:\/tcp)?$/.test(mapping));
  const has8443 = mappings.some((mapping) => /(^|:)8443(?::|\/tcp|$)/.test(mapping));
  return has80 && has443 && !has8443;
}

export function usesStandardAutomaticHttps(caddyfile) {
  const active = stripConfigComments(caddyfile);
  return /^\s*chatcircle\.empact\.cn\s*\{/m.test(active)
    && !/chatcircle\.empact\.cn:8443/.test(active)
    && !/\bdns\s+alidns\b/.test(active)
    && !/ALIYUN_ACCESS_KEY_(?:ID|SECRET)/.test(active);
}

function getWorkflowStep(workflow, stepName) {
  const lines = stripConfigComments(workflow).split('\n');
  let start = -1;
  let stepIndent = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)-\s+name:\s*(.*?)\s*$/.exec(lines[index]);
    if (match?.[2] === stepName) {
      start = index;
      stepIndent = match[1].length;
      break;
    }
  }

  if (start < 0) return '';

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(\s*)-\s+name:/.exec(lines[index]);
    if (match && match[1].length === stepIndent) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}

const preflightStep = (workflow) => getWorkflowStep(workflow, '预检目标版本并构建');
const deployStep = (workflow) => getWorkflowStep(workflow, '更新生产版本并健康检查');

export function hasPreflightComposeValidation(workflow) {
  return /^\s*docker compose config -q\s*$/m.test(preflightStep(workflow));
}

export function hasCandidateImagePreflightBuild(workflow) {
  return /^\s*docker compose --project-name "\$preflight_project" build\s*$/m.test(preflightStep(workflow));
}

export function hasCandidateBackupRuntimeSmoke(workflow) {
  const step = preflightStep(workflow);
  const build = step.indexOf('docker compose --project-name "$preflight_project" build');
  const smoke = step.indexOf('./deploy/smoke-backup-runtime.sh "chatcircle-backup:$target_sha"');
  return build >= 0 && smoke >= 0 && build < smoke;
}

export function hasRuntimeImagePreflightPull(workflow) {
  return /^\s*docker compose --project-name "\$preflight_project" pull caddy\s*$/m.test(preflightStep(workflow));
}

export function rejectsLegacyServerOverride(workflow) {
  const step = preflightStep(workflow);
  return /^\s*if \[ -f docker-compose\.override\.yml \]; then\s*$/m.test(step)
    && /legacy \/opt\/chatcircle\/docker-compose\.override\.yml/.test(step)
    && /^\s*exit 1\s*$/m.test(step);
}

export function hasPreflightPhoneKeyValidation(workflow) {
  return /^\s*if \[ "\$\{#CC_PHONE_HASH_KEY\}" -lt 32 \]; then\s*$/m.test(preflightStep(workflow));
}

// 生产（production + aliyun）短信必填变量（§4.2）。STS token 与 scheme 属可选，不在此列。
export const SMS_REQUIRED_VARS = [
  'ALIBABA_CLOUD_ACCESS_KEY_ID',
  'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
  'CC_SMS_SIGN_NAME',
  'CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE',
  'CC_SMS_TEMPLATE_BIND_NEW_CODE',
  'CC_SMS_TEMPLATE_VERIFY_BOUND_CODE',
];

export function hasPreflightSmsValidation(workflow) {
  const step = preflightStep(workflow);
  return SMS_REQUIRED_VARS.every((name) => step.includes(name));
}

export function hasPostDeployHealthCheck(workflow) {
  const step = deployStep(workflow);
  return /^\s*app_id="\$\(docker compose ps -q app\)"\s*$/m.test(step)
    && /docker inspect[^\n]*\.State\.Health\.Status/m.test(step);
}

export function hasBackupPreDeployReadiness(workflow) {
  const step = deployStep(workflow);
  return /backup_ready=0/.test(step)
    && /docker compose exec -T --interactive=false backup sh -eu -c/.test(step)
    && /test "\$\(cat \/proc\/1\/comm\)" = crond/.test(step)
    && /grep -qx ["']?# cc-backup-lock-v1/.test(step)
    && /seq 1 45/.test(step)
    && /一次性迁移说明/.test(step);
}

export function hasBackupPostDeployHealthCheck(workflow) {
  const step = deployStep(workflow);
  return /backup_id="\$\(docker compose ps -q backup\)"/.test(step)
    && /backup_healthy=0/.test(step)
    && /docker inspect[^\n]*\.State\.Health\.Status/.test(step)
    && /docker compose logs --tail=120 backup/.test(step);
}

export function hasBackupRevisionBinding(workflow) {
  const step = deployStep(workflow);
  return /backup_revision="\$\(docker inspect --format/.test(step)
    && /test "\$backup_revision" = "\$target_sha"/.test(step);
}

export function hasSerializedBackupGateBeforeSwitch(workflow) {
  const step = deployStep(workflow);
  const gate = step.indexOf('exec sh /etc/periodic/daily/backup');
  const switchIndex = step.indexOf('git merge --ff-only "$target_sha"');
  return gate >= 0 && switchIndex >= 0 && gate < switchIndex;
}

export function hasCiSuccessGate(workflow) {
  const active = stripConfigComments(workflow);
  return /workflow_run:[\s\S]*workflows:\s*\[CI\]/m.test(active)
    && /listWorkflowRuns\(/.test(active)
    && /conclusion === ['"]success['"]/.test(active)
    && /run\.event === ['"]push['"]/.test(active)
    && /run\.head_branch === ['"]main['"]/.test(active)
    && /^\s*needs:\s+verify-ci\s*$/m.test(active);
}

export function hasImmutableDeploySha(workflow) {
  const active = stripConfigComments(workflow);
  return /DEPLOY_SHA:\s*\$\{\{ needs\.verify-ci\.outputs\.target_sha \}\}/.test(active)
    && (active.match(/target_sha="\$1"/g) || []).length >= 2
    && /git cat-file -e "\$target_sha\^\{commit\}"/.test(active)
    && /git worktree add --detach "\$candidate_dir" "\$target_sha"/.test(active);
}

export function hasManualShaCiValidation(workflow) {
  const active = stripConfigComments(workflow);
  return /workflow_dispatch:[\s\S]*deploy_sha:[\s\S]*required:\s*true/m.test(active)
    && /context\.eventName === ['"]workflow_run['"]/.test(active)
    && /REQUESTED_SHA:\s*\$\{\{ inputs\.deploy_sha \}\}/.test(active)
    && /SHA 必须是 40 位/.test(active);
}

// —— 公开页 SSR 渲染服务（public-web，见 docs/planning/public-web-ssr-plan.md）——

/** 取 compose 中某服务的配置块（两空格缩进的服务键到下一个同级/顶层键为止）。 */
function getComposeServiceBlock(compose, serviceName) {
  const lines = stripConfigComments(compose).split('\n');
  const start = lines.findIndex((line) => new RegExp(`^  ${serviceName}:\\s*$`).test(line));
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  \S/.test(lines[index]) || /^\S/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** 从 openBraceIndex（'{' 的位置）起做括号配对，返回含大括号的完整块；配对失败返回 ''。 */
function extractBracedBlock(text, openBraceIndex) {
  let depth = 0;
  for (let index = openBraceIndex; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openBraceIndex, index + 1);
    }
  }
  return '';
}

/** 取 Caddyfile 中匹配 pattern 的指令的完整 { } 块（支持嵌套，如 handle 内的 reverse_proxy）。 */
function extractDirectiveBlock(activeConfig, pattern) {
  const match = pattern.exec(activeConfig);
  if (!match) return '';
  return extractBracedBlock(activeConfig, activeConfig.indexOf('{', match.index));
}

/** 取 Caddyfile 命名匹配器的 path 列表（@name path ... 单行定义）。 */
function getMatcherPaths(activeConfig, matcherName) {
  const match = new RegExp(`@${matcherName}\\s+path\\s+([^\\n]+)`).exec(activeConfig);
  return match ? match[1].trim().split(/\s+/) : null;
}

// Caddy 路由口径（与 frontend/src/public/routes.ts、frontend/src/router.tsx 一一对应）
export const PUBLIC_META_CADDY_PATHS = ['/public-assets/*', '/robots.txt', '/sitemap.xml'];
export const PUBLIC_PAGE_CADDY_PATHS = ['/', '/about', '/privacy', '/activities', '/activities/past', '/a/*', '/posts/*'];
export const FUNCTIONAL_SPA_CADDY_PATHS = [
  '/login', '/me', '/trainings', '/checkin/*', '/training-checkin/*', '/survey/*',
  '/admin/*', '/super/*', '/a/*/register',
];

export function hasBuiltPublicWebRuntime(compose) {
  const block = getComposeServiceBlock(compose, 'public-web');
  return block !== ''
    && /image:\s+chatcircle-public-web:\$\{CC_RELEASE_SHA:-local\}/.test(block)
    && /context:\s+\.\s*$/m.test(block)
    && /dockerfile:\s+deploy\/public-web\.Dockerfile/.test(block);
}

export function hasIsolatedPublicWebService(compose) {
  const block = getComposeServiceBlock(compose, 'public-web');
  // 不发布 host 端口、不挂任何卷（尤其不得碰 pb_data）：仅经 Docker 私网被 Caddy 访问
  return block !== ''
    && !/^\s+ports:/m.test(block)
    && !/^\s+volumes:/m.test(block)
    && !block.includes('pb_data');
}

export function hasPublicWebUpstreamConfig(compose) {
  const block = getComposeServiceBlock(compose, 'public-web');
  return /CC_PB_INTERNAL_URL:\s*http:\/\/app:8090\s*$/m.test(block)
    && /CC_SITE_ORIGIN:\s*\$\{CC_SITE_ORIGIN:-https:\/\/chatcircle\.empact\.cn\}/.test(block);
}

export function hasPublicWebCaddyRouting(caddyfile) {
  const active = stripConfigComments(caddyfile);
  const covers = (actual, expected) => actual !== null && expected.every((path) => actual.includes(path));
  // 静态资源/爬虫入口与公开页两组 matcher 指向 public-web，外加兜底 handle 的真实 404
  return /\broute\s*\{/.test(active)
    && covers(getMatcherPaths(active, 'publicMeta'), PUBLIC_META_CADDY_PATHS)
    && covers(getMatcherPaths(active, 'publicPages'), PUBLIC_PAGE_CADDY_PATHS)
    && extractDirectiveBlock(active, /handle\s+@publicMeta\b/).includes('reverse_proxy public-web:3100')
    && extractDirectiveBlock(active, /handle\s+@publicPages\b/).includes('reverse_proxy public-web:3100')
    && extractDirectiveBlock(active, /handle\s*\{/).includes('reverse_proxy public-web:3100');
}

export function hasFunctionalSpaNoindex(caddyfile) {
  const active = stripConfigComments(caddyfile);
  const paths = getMatcherPaths(active, 'functionalSpa');
  if (!paths || !FUNCTIONAL_SPA_CADDY_PATHS.every((path) => paths.includes(path))) return false;
  const block = extractDirectiveBlock(active, /handle\s+@functionalSpa\b/);
  return /header\s+X-Robots-Tag\s+"noindex"/.test(block)
    && block.includes('reverse_proxy app:8090');
}

export function hasRegisterBeforePublicActivity(caddyfile) {
  const active = stripConfigComments(caddyfile);
  // /a/:id/register（功能 SPA）必须先于 /a/*（公开详情）命中，否则报名页会被 SSR 404
  const functional = active.search(/handle\s+@functionalSpa\b/);
  const publicPages = active.search(/handle\s+@publicPages\b/);
  return functional >= 0 && publicPages >= 0 && functional < publicPages;
}

export function hasXffOverrideOnAllUpstreams(caddyfile) {
  const active = stripConfigComments(caddyfile);
  // 每个 reverse_proxy 上游都必须带覆盖 XFF 的块（app 与 public-web 两侧缺一不可；
  // 无 { } 块的 reverse_proxy 视为缺 XFF，不得漏数）
  const upstreams = [...active.matchAll(/\breverse_proxy\s+\S+/g)];
  if (upstreams.length < 2) return false;
  return upstreams.every((upstream) => {
    const afterTarget = upstream.index + upstream[0].length;
    const rest = active.slice(afterTarget);
    if (!/^\s*\{/.test(rest)) return false;
    const block = extractBracedBlock(active, afterTarget + rest.indexOf('{'));
    return /header_up\s+X-Forwarded-For\s+\{remote_host\}/.test(block);
  });
}

export function hasCandidatePublicWebSmoke(workflow) {
  const step = preflightStep(workflow);
  const build = step.indexOf('docker compose --project-name "$preflight_project" build');
  const smoke = step.indexOf('./deploy/smoke-public-web-runtime.sh "chatcircle-public-web:$target_sha"');
  return build >= 0 && smoke >= 0 && build < smoke;
}

export function hasPublicWebPostDeployHealthCheck(workflow) {
  const step = deployStep(workflow);
  return /public_web_id="\$\(docker compose ps -q public-web\)"/.test(step)
    && /public_web_healthy=0/.test(step)
    && /docker inspect[^\n]*\.State\.Health\.Status/.test(step)
    && /docker compose logs --tail=120 public-web/.test(step);
}

export function hasPostDeployPublicWebGate(workflow) {
  const step = deployStep(workflow);
  // 首页原始 HTML 必须带 canonical 与首帧数据标记（证明经 SSR 渲染而非 SPA 空壳），
  // robots.txt 由渲染服务下发且含 sitemap 指引
  return step.includes('https://chatcircle.empact.cn/')
    && step.includes('rel="canonical"')
    && step.includes('__CC_PUBLIC_DATA__')
    && step.includes('https://chatcircle.empact.cn/robots.txt');
}
