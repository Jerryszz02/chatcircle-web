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
          if [ "\${#CC_PHONE_HASH_KEY}" -lt 32 ]; then`,
    deploy: `
          if docker compose exec -T app wget -qO- http://127.0.0.1:8090/api/health >/dev/null 2>&1; then`,
  });

  assert.equal(hasPreflightComposeValidation(source), true);
  assert.equal(hasCandidateImagePreflightBuild(source), true);
  assert.equal(hasPreflightPhoneKeyValidation(source), true);
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
  assert.equal(hasPostDeployHealthCheck(source), false);
});
