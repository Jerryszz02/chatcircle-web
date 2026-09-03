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

export function hasLoopbackOnlyPocketBasePort(compose) {
  const activeCompose = stripConfigComments(compose);
  const shortMappings = [...activeCompose.matchAll(/^\s*-\s*(?:'([^']+)'|"([^"]+)"|([^\s]+))\s*$/gm)]
    .map((match) => match[1] || match[2] || match[3])
    .filter((mapping) => /(^|:)8090(?:\/tcp)?$/.test(mapping));

  // 无 8090 映射（生产默认不向 host 发布 PocketBase 端口，仅在 Docker 私网供 Caddy/backup
  // 访问 —— 2026-09 安全加固）同样满足「不得暴露到公网」；有映射则必须全部只绑 127.0.0.1。
  return shortMappings.length === 0
    || shortMappings.every((mapping) => /^127\.0\.0\.1:\d+:8090(?:\/tcp)?$/.test(mapping));
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

export function hasPreflightPhoneKeyValidation(workflow) {
  return /^\s*if \[ "\$\{#CC_PHONE_HASH_KEY\}" -lt 32 \]; then\s*$/m.test(preflightStep(workflow));
}

export function hasPostDeployHealthCheck(workflow) {
  return /^\s*if docker compose exec -T app wget -qO- http:\/\/127\.0\.0\.1:8090\/api\/health >\/dev\/null 2>&1; then\s*$/m.test(deployStep(workflow));
}
