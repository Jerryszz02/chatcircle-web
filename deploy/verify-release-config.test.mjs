import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasActiveAdminConsoleBlock,
  hasActiveConfigText,
  hasCandidateImagePreflightBuild,
  hasLoopbackOnlyPocketBasePort,
  hasPostDeployHealthCheck,
  hasPreflightComposeValidation,
  hasPreflightPhoneKeyValidation,
  hasPreflightSmsValidation,
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
  // 无 8090 映射（生产不发布 host 端口）同样不暴露到公网 → 通过
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

test('accepts active deployment safeguards in their intended steps', () => {
  const source = workflow({
    preflight: `
          docker compose config -q
          docker compose --project-name "$preflight_project" build
          if [ "\${#CC_PHONE_HASH_KEY}" -lt 32 ]; then
          if [ "\${CC_ENVIRONMENT:-}" = "production" ] && [ "\${CC_SMS_PROVIDER:-}" = "aliyun" ]; then
          for name in ALIBABA_CLOUD_ACCESS_KEY_ID ALIBABA_CLOUD_ACCESS_KEY_SECRET CC_SMS_SIGN_NAME CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE CC_SMS_TEMPLATE_BIND_NEW_CODE CC_SMS_TEMPLATE_VERIFY_BOUND_CODE; do`,
    deploy: `
          docker compose up --build -d
          app_id="$(docker compose ps -q app)"
          status="$(docker inspect --format '{{.State.Health.Status}}' "$app_id" 2>/dev/null || echo '')"`,
  });

  assert.equal(hasPreflightComposeValidation(source), true);
  assert.equal(hasCandidateImagePreflightBuild(source), true);
  assert.equal(hasPreflightPhoneKeyValidation(source), true);
  assert.equal(hasPreflightSmsValidation(source), true);
  assert.equal(hasPostDeployHealthCheck(source), true);
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
          # docker compose config -q
          # docker compose --project-name "$preflight_project" build
          # if [ "\${#CC_PHONE_HASH_KEY}" -lt 32 ]; then
          # if docker compose exec -T app wget -qO- http://127.0.0.1:8090/api/health >/dev/null 2>&1; then`,
    deploy: `
          docker compose config -q
          docker compose --project-name "$preflight_project" build
          docker compose up --build -d
          if [ "\${#CC_PHONE_HASH_KEY}" -lt 32 ]; then`,
  });

  assert.equal(hasPreflightComposeValidation(source), false);
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

  // 缺少任一生产必填变量时预检失败（逐项验证）。
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

  // 可选变量 ALIBABA_CLOUD_SECURITY_TOKEN 与 CC_SMS_SCHEME_NAME 不出现仍应通过。
  assert.equal(hasPreflightSmsValidation(workflow({
    preflight: `
          for name in ${required}; do`,
  })), true);
});
