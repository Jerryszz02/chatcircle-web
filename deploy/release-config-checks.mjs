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

export function hasRuntimeImagePreflightPull(workflow) {
  return /^\s*docker compose --project-name "\$preflight_project" pull caddy backup\s*$/m.test(preflightStep(workflow));
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
