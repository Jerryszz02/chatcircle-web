import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasActiveAdminConsoleBlock,
  hasActiveConfigText,
  hasBackupPostDeployHealthCheck,
  hasBackupPreDeployReadiness,
  hasBackupRevisionBinding,
  hasCandidateBackupRuntimeSmoke,
  hasBuiltBackupRuntime,
  hasCandidateImagePreflightBuild,
  hasLoopbackOnlyPocketBasePort,
  hasPostDeployHealthCheck,
  hasCiSuccessGate,
  hasImmutableDeploySha,
  hasManualShaCiValidation,
  hasPreflightComposeValidation,
  hasPreflightPhoneKeyValidation,
  hasPreflightSmsValidation,
  hasRuntimeImagePreflightPull,
  hasSerializedBackupGateBeforeSwitch,
  hasStandardCaddyPublicPorts,
  rejectsLegacyServerOverride,
  usesStandardAutomaticHttps,
} from './release-config-checks.mjs';

const workflow = ({ preflight = '', deploy = '' } = {}) => `
jobs:
  deploy:
    steps:
      - name: 预检目标版本并构建
        run: |
${preflight}
      - name: 更新生产版本并健康检查
        run: |
${deploy}
`;

test('accepts an active admin-console deny handler', () => {
  assert.equal(hasActiveAdminConsoleBlock(`
    handle /_/* {
      respond 403
    }
  `), true);
});

test('rejects a deny handler that only appears in comments', () => {
  assert.equal(hasActiveAdminConsoleBlock(`
    # handle /_/* {
    #   respond 403
    # }
  `), false);
});

test('requires respond 403 inside the admin-console handler', () => {
  assert.equal(hasActiveAdminConsoleBlock(`
    handle /_/* {
      reverse_proxy app:8090
    }

    handle {
      respond 403
    }
  `), false);
});

test('requires active Caddy security directives', () => {
  assert.equal(hasActiveConfigText('# Strict-Transport-Security disabled', 'Strict-Transport-Security'), false);
  assert.equal(hasActiveConfigText('Strict-Transport-Security "max-age=31536000"', 'Strict-Transport-Security'), true);
});

test('accepts only an active loopback PocketBase short port mapping, or no mapping at all', () => {
  assert.equal(hasLoopbackOnlyPocketBasePort(`
    ports:
      - '127.0.0.1:8090:8090'
  `), true);
  assert.equal(hasLoopbackOnlyPocketBasePort(`
    # 生产默认不向 host 发布 PocketBase 端口
    volumes:
      - pb_data:/pb/pb_data
  `), true);
  assert.equal(hasLoopbackOnlyPocketBasePort(`
    ports:
      # - '127.0.0.1:8090:8090'
      - 8090:8090
  `), false);
  assert.equal(hasLoopbackOnlyPocketBasePort(`
    ports:
      - "0.0.0.0:8090:8090"
  `), false);
});

test('requires a built backup runtime image and rejects runtime apk installation', () => {
  assert.equal(hasBuiltBackupRuntime(`
    backup:
      image: chatcircle-backup:\${CC_RELEASE_SHA:-local}
      build:
        context: ./deploy
        dockerfile: backup.Dockerfile
  `), true);
  assert.equal(hasBuiltBackupRuntime(`
    backup:
      image: alpine:3.20
      command: apk add --no-cache tzdata flock
  `), false);
});

test('requires formal Caddy 80/443 ports and rejects legacy 8443', () => {
  assert.equal(hasStandardCaddyPublicPorts(`
    caddy:
      ports:
        - '80:80'
        - '443:443'
  `), true);
  assert.equal(hasStandardCaddyPublicPorts(`
    caddy:
      ports:
        - '443:443'
  `), false);
  assert.equal(hasStandardCaddyPublicPorts(`
    caddy:
      ports:
        - '80:80'
        - '443:443'
        - '8443:8443'
  `), false);
});

test('requires Caddy standard Automatic HTTPS without DNS-01 credentials', () => {
  assert.equal(usesStandardAutomaticHttps(`
    chatcircle.empact.cn {
      reverse_proxy app:8090
    }
  `), true);
  assert.equal(usesStandardAutomaticHttps(`
    chatcircle.empact.cn:8443 {
      reverse_proxy app:8090
    }
  `), false);
  assert.equal(usesStandardAutomaticHttps(`
    chatcircle.empact.cn {
      tls {
        dns alidns {
          access_key_id {$ALIYUN_ACCESS_KEY_ID}
        }
      }
    }
  `), false);
});

test('accepts active deployment safeguards in their intended steps', () => {
  const source = workflow({
    preflight: `
          if [ -f docker-compose.override.yml ]; then
            echo "ERROR: 检测到 legacy /opt/chatcircle/docker-compose.override.yml" >&2
            exit 1
          fi
          docker compose config -q
          docker compose --project-name "$preflight_project" pull caddy
          docker compose --project-name "$preflight_project" build
          ./deploy/smoke-backup-runtime.sh "chatcircle-backup:$target_sha"
          if [ "\${#CC_PHONE_HASH_KEY}" -lt 32 ]; then
          if [ "\${CC_ENVIRONMENT:-}" = "production" ] && [ "\${CC_SMS_PROVIDER:-}" = "aliyun" ]; then
          for name in ALIBABA_CLOUD_ACCESS_KEY_ID ALIBABA_CLOUD_ACCESS_KEY_SECRET CC_SMS_SIGN_NAME CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE CC_SMS_TEMPLATE_BIND_NEW_CODE CC_SMS_TEMPLATE_VERIFY_BOUND_CODE; do`,
    deploy: `
          docker compose up --build -d
          backup_id="$(docker compose ps -q backup)"
          backup_ready=0
          for attempt in $(seq 1 45); do
            echo "一次性迁移说明"
            docker compose exec -T --interactive=false backup sh -eu -c '
              test "$(cat /proc/1/comm)" = crond
              command -v flock >/dev/null
              grep -qx "# cc-backup-lock-v1" /etc/periodic/daily/backup
            '
            backup_ready=1
            break
          done
          exec sh /etc/periodic/daily/backup
          app_id="$(docker compose ps -q app)"
          status="$(docker inspect --format '{{.State.Health.Status}}' "$app_id" 2>/dev/null || echo '')"
          backup_healthy=0
          docker inspect --format '{{.State.Health.Status}}' "$backup_id"
          backup_revision="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$backup_id")"
          test "$backup_revision" = "$target_sha"
          git merge --ff-only "$target_sha"
          docker compose logs --tail=120 backup`,
  });

  assert.equal(rejectsLegacyServerOverride(source), true);
  assert.equal(hasPreflightComposeValidation(source), true);
  assert.equal(hasRuntimeImagePreflightPull(source), true);
  assert.equal(hasCandidateImagePreflightBuild(source), true);
  assert.equal(hasCandidateBackupRuntimeSmoke(source), true);
  assert.equal(hasPreflightPhoneKeyValidation(source), true);
  assert.equal(hasPreflightSmsValidation(source), true);
  assert.equal(hasPostDeployHealthCheck(source), true);
  assert.equal(hasBackupPreDeployReadiness(source), true);
  assert.equal(hasBackupPostDeployHealthCheck(source), true);
  assert.equal(hasBackupRevisionBinding(source), true);
  assert.equal(hasSerializedBackupGateBeforeSwitch(source), true);
});

test('backup gate ordering rejects missing gate or switch instead of comparing -1', () => {
  assert.equal(hasSerializedBackupGateBeforeSwitch(workflow({ deploy: 'git merge --ff-only "$target_sha"' })), false);
  assert.equal(hasSerializedBackupGateBeforeSwitch(workflow({ deploy: 'docker compose exec -T --interactive=false backup true' })), false);
  assert.equal(hasSerializedBackupGateBeforeSwitch(workflow({
    deploy: "docker compose exec -T --interactive=false backup sh -c 'test true'\ngit merge --ff-only \"$target_sha\"",
  })), false);
});

test('requires CI success and immutable SHA binding for deployment', () => {
  const source = `
    on:
      workflow_run:
        workflows: [CI]
      workflow_dispatch:
        inputs:
          deploy_sha:
            required: true
    jobs:
      verify-ci:
        steps:
          needs: verify-ci
          env:
            REQUESTED_SHA: \${{ inputs.deploy_sha }}
          const sha = context.eventName === 'workflow_run' ? context.payload.workflow_run.head_sha : process.env.REQUESTED_SHA;
          if (!/^[0-9a-f]{40}$/.test(sha)) core.setFailed('SHA 必须是 40 位');
          listWorkflowRuns({});
          run.event === 'push'; run.head_branch === 'main';
          run.conclusion === 'success';
      deploy:
        needs: verify-ci
        env:
          DEPLOY_SHA: \${{ needs.verify-ci.outputs.target_sha }}
        run: |
          target_sha="$1"
          git cat-file -e "$target_sha^{commit}"
          git worktree add --detach "$candidate_dir" "$target_sha"
          target_sha="$1"
          target_sha="$1"
    `;
  assert.equal(hasCiSuccessGate(source), true);
  assert.equal(hasImmutableDeploySha(source), true);
  assert.equal(hasManualShaCiValidation(source), true);
});

test('rejects host-level PocketBase health checks after host port removal', () => {
  const source = workflow({
    deploy: `
          if curl -fsS http://127.0.0.1:8090/api/health >/dev/null 2>&1; then`,
  });

  assert.equal(hasPostDeployHealthCheck(source), false);
});

test('rejects commented safeguards and commands in the wrong step', () => {
  const source = workflow({
    preflight: `
          # if [ -f docker-compose.override.yml ]; then
          # docker compose config -q
          # docker compose --project-name "$preflight_project" pull caddy backup
          # docker compose --project-name "$preflight_project" build
          # if [ "\${#CC_PHONE_HASH_KEY}" -lt 32 ]; then`,
    deploy: `
          docker compose config -q
          docker compose --project-name "$preflight_project" pull caddy
          docker compose --project-name "$preflight_project" build
          docker compose up --build -d
          if [ "\${#CC_PHONE_HASH_KEY}" -lt 32 ]; then`,
  });

  assert.equal(rejectsLegacyServerOverride(source), false);
  assert.equal(hasPreflightComposeValidation(source), false);
  assert.equal(hasRuntimeImagePreflightPull(source), false);
  assert.equal(hasCandidateImagePreflightBuild(source), false);
  assert.equal(hasPreflightPhoneKeyValidation(source), false);
  assert.equal(hasPreflightSmsValidation(source), false);
  assert.equal(hasPostDeployHealthCheck(source), false);
});

test('production SMS preflight requires every required variable', () => {
  const allRequired = [
    'ALIBABA_CLOUD_ACCESS_KEY_ID',
    'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
    'CC_SMS_SIGN_NAME',
    'CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE',
    'CC_SMS_TEMPLATE_BIND_NEW_CODE',
    'CC_SMS_TEMPLATE_VERIFY_BOUND_CODE',
  ];

  assert.equal(hasPreflightSmsValidation(workflow({
    preflight: `
          for name in ${allRequired.join(' ')}; do`,
  })), true);

  for (const missing of allRequired) {
    const subset = allRequired.filter((name) => name !== missing);
    assert.equal(hasPreflightSmsValidation(workflow({
      preflight: `
            for name in ${subset.join(' ')}; do`,
    })), false, `缺少 ${missing} 时不应通过`);
  }
});

test('production SMS preflight still passes without optional STS token or scheme', () => {
  const required = [
    'ALIBABA_CLOUD_ACCESS_KEY_ID',
    'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
    'CC_SMS_SIGN_NAME',
    'CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE',
    'CC_SMS_TEMPLATE_BIND_NEW_CODE',
    'CC_SMS_TEMPLATE_VERIFY_BOUND_CODE',
  ].join(' ');

  assert.equal(hasPreflightSmsValidation(workflow({
    preflight: `
          for name in ${required}; do`,
  })), true);
});
