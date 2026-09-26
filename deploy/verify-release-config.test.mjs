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
  hasCandidatePublicWebSmoke,
  hasBuiltPublicWebRuntime,
  hasFunctionalSpaNoindex,
  hasIsolatedPublicWebService,
  hasLoopbackOnlyPocketBasePort,
  hasPostDeployHealthCheck,
  hasPostDeployPublicWebGate,
  hasPublicWebCaddyRouting,
  hasPublicWebPostDeployHealthCheck,
  hasPublicWebUpstreamConfig,
  hasRegisterBeforePublicActivity,
  hasCiSuccessGate,
  hasImmutableDeploySha,
  hasManualShaCiValidation,
  hasPreflightComposeValidation,
  hasPreflightPhoneKeyValidation,
  hasPreflightSmsValidation,
  hasRuntimeImagePreflightPull,
  hasSerializedBackupGateBeforeSwitch,
  hasStandardCaddyPublicPorts,
  hasXffOverrideOnAllUpstreams,
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

// —— 公开页 SSR 渲染服务（public-web）检查 ——

const publicWebCompose = `
  app:
    image: chatcircle-app:\${CC_RELEASE_SHA:-local}
  public-web:
    image: chatcircle-public-web:\${CC_RELEASE_SHA:-local}
    build:
      context: .
      dockerfile: deploy/public-web.Dockerfile
      args:
        CC_RELEASE_SHA: \${CC_RELEASE_SHA:-local}
    depends_on:
      app:
        condition: service_healthy
    environment:
      PORT: 3100
      CC_SITE_ORIGIN: \${CC_SITE_ORIGIN:-https://chatcircle.empact.cn}
      CC_PB_INTERNAL_URL: http://app:8090
    restart: unless-stopped
  caddy:
    image: caddy:2-alpine
    ports:
      - '80:80'
      - '443:443'
volumes:
  pb_data:
`;

test('public-web compose 服务必须提交绑定、配置齐全且无 host 端口/卷', () => {
  assert.equal(hasBuiltPublicWebRuntime(publicWebCompose), true);
  assert.equal(hasIsolatedPublicWebService(publicWebCompose), true);
  assert.equal(hasPublicWebUpstreamConfig(publicWebCompose), true);
});

test('public-web 发布 host 端口或挂卷即拒绝', () => {
  const withPorts = publicWebCompose.replace('    environment:', '    ports:\n      - "3100:3100"\n    environment:');
  assert.equal(hasIsolatedPublicWebService(withPorts), false);
  const withVolume = publicWebCompose.replace('    environment:', '    volumes:\n      - pb_data:/data\n    environment:');
  assert.equal(hasIsolatedPublicWebService(withVolume), false);
  assert.equal(hasIsolatedPublicWebService('app:\n    image: x'), false);
});

test('public-web 上游必须指向 compose 私网的 app:8090', () => {
  assert.equal(
    hasPublicWebUpstreamConfig(publicWebCompose.replace('http://app:8090', 'http://127.0.0.1:8090')),
    false,
  );
  assert.equal(hasBuiltPublicWebRuntime(''), false);
});

const caddyWithPublicWeb = `
chatcircle.empact.cn {
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
	}
	@publicMeta path /public-assets/* /robots.txt /sitemap.xml
	@api path /api/*
	@spaAssets path /assets/*
	@functionalSpa path /login /me /trainings /checkin/* /training-checkin/* /survey/* /admin/* /super/* /a/*/register
	@publicPages path / /about /privacy /activities /activities/past /a/* /posts/*
	route {
		handle /_/* {
			respond 403
		}
		handle @publicMeta {
			reverse_proxy public-web:3100 {
				header_up X-Forwarded-For {remote_host}
			}
		}
		handle @api {
			reverse_proxy app:8090 {
				header_up X-Forwarded-For {remote_host}
			}
		}
		handle @spaAssets {
			reverse_proxy app:8090 {
				header_up X-Forwarded-For {remote_host}
			}
		}
		handle @functionalSpa {
			header X-Robots-Tag "noindex"
			reverse_proxy app:8090 {
				header_up X-Forwarded-For {remote_host}
			}
		}
		handle @publicPages {
			reverse_proxy public-web:3100 {
				header_up X-Forwarded-For {remote_host}
			}
		}
		handle {
			reverse_proxy public-web:3100 {
				header_up X-Forwarded-For {remote_host}
			}
		}
	}
}
`;

test('Caddy 公开页路由、功能 SPA noindex、顺序与 XFF 覆盖', () => {
  assert.equal(hasPublicWebCaddyRouting(caddyWithPublicWeb), true);
  assert.equal(hasFunctionalSpaNoindex(caddyWithPublicWeb), true);
  assert.equal(hasRegisterBeforePublicActivity(caddyWithPublicWeb), true);
  assert.equal(hasXffOverrideOnAllUpstreams(caddyWithPublicWeb), true);
  assert.equal(hasActiveAdminConsoleBlock(caddyWithPublicWeb), true);
});

test('Caddy 公开页路由缺路径或缺上游即拒绝', () => {
  assert.equal(
    hasPublicWebCaddyRouting(caddyWithPublicWeb.replace('/sitemap.xml', '')),
    false,
    'publicMeta 缺 /sitemap.xml 不应通过',
  );
  assert.equal(
    hasPublicWebCaddyRouting(caddyWithPublicWeb.replace('/activities/past', '')),
    false,
    'publicPages 缺 /activities/past 不应通过',
  );
  assert.equal(
    hasPublicWebCaddyRouting(caddyWithPublicWeb.replaceAll('reverse_proxy public-web:3100', 'reverse_proxy public-web:3101')),
    false,
  );
  assert.equal(hasPublicWebCaddyRouting('chatcircle.empact.cn {\n\treverse_proxy app:8090\n}'), false);
});

test('Caddy 功能 SPA 缺 noindex 或路径不全即拒绝', () => {
  assert.equal(
    hasFunctionalSpaNoindex(caddyWithPublicWeb.replace('	header X-Robots-Tag "noindex"\n', '')),
    false,
  );
  assert.equal(
    hasFunctionalSpaNoindex(caddyWithPublicWeb.replace(' /a/*/register', '')),
    false,
    '功能组缺 /a/*/register 不应通过',
  );
});

test('报名路由必须先于公开活动详情命中', () => {
  const removed = caddyWithPublicWeb.replace(/handle @functionalSpa \{[\s\S]*?\n\t\t\}\n/, '');
  assert.equal(hasRegisterBeforePublicActivity(removed), false, '缺功能组 handle 不应通过');

  // 真正交换顺序：功能组 handle 挪到兜底 handle 前（即公开组之后，/a/* 会先截获 /a/*/register）
  const functionalHandle = /(\t\thandle @functionalSpa \{[\s\S]*?\n\t\t\}\n)/;
  const match = functionalHandle.exec(caddyWithPublicWeb);
  const without = caddyWithPublicWeb.replace(functionalHandle, '');
  const swapped = without.replace(/\t\thandle \{/, `${match[1]}\t\thandle {`);
  assert.notEqual(swapped, without, '测试 fixture 必须真的交换了顺序');
  assert.equal(hasRegisterBeforePublicActivity(swapped), false, '功能组排在公开组之后不应通过');
});

test('任一上游缺 XFF 覆盖即拒绝', () => {
  // 只保留 publicMeta 一处 XFF，其余上游移除
  const missing = caddyWithPublicWeb.replace(
    /handle @publicPages \{\n\t\t\treverse_proxy public-web:3100 \{\n\t\t\t\theader_up X-Forwarded-For \{remote_host\}\n\t\t\t\}\n\t\t\}/,
    'handle @publicPages {\n\t\t\treverse_proxy public-web:3100\n\t\t}',
  );
  assert.equal(hasXffOverrideOnAllUpstreams(missing), false);
  // 只剩单上游的旧配置（无 route 分组）不满足双侧覆盖
  assert.equal(hasXffOverrideOnAllUpstreams(`
    handle {
      reverse_proxy app:8090 {
        header_up X-Forwarded-For {remote_host}
      }
    }
  `), false);
});

test('public-web 部署 workflow 门禁：smoke 顺序、容器健康与 SSR 标记', () => {
  const source = workflow({
    preflight: `
          docker compose --project-name "$preflight_project" build
          ./deploy/smoke-public-web-runtime.sh "chatcircle-public-web:$target_sha"`,
    deploy: `
          public_web_id="$(docker compose ps -q public-web)"
          public_web_healthy=0
          status="$(docker inspect --format '{{.State.Health.Status}}' "$public_web_id" 2>/dev/null || echo '')"
          docker compose logs --tail=120 public-web
          home_html="$(curl --fail https://chatcircle.empact.cn/)"
          grep -q 'rel="canonical"' <<<"$home_html"
          grep -q '__CC_PUBLIC_DATA__' <<<"$home_html"
          curl --fail https://chatcircle.empact.cn/robots.txt`,
  });
  assert.equal(hasCandidatePublicWebSmoke(source), true);
  assert.equal(hasPublicWebPostDeployHealthCheck(source), true);
  assert.equal(hasPostDeployPublicWebGate(source), true);

  // smoke 必须先于构建之后（顺序颠倒不允许）
  assert.equal(hasCandidatePublicWebSmoke(workflow({
    preflight: `
          ./deploy/smoke-public-web-runtime.sh "chatcircle-public-web:$target_sha"
          docker compose --project-name "$preflight_project" build`,
  })), false);
  // 只 curl 健康端点不算 SSR 门禁
  assert.equal(hasPostDeployPublicWebGate(workflow({
    deploy: 'curl --fail https://chatcircle.empact.cn/api/cc/health',
  })), false);
});
