#!/bin/sh
# Validate an already-built public-web image with no network, no upstream,
# no volumes and no credentials. The same smoke runs in CI and deployment preflight.
#
# 断言口径（全部在无网络容器内完成，loopback 仍可用；上游显式指向不可达地址）：
#   /healthz     → 200（浅活探针，不依赖上游）
#   /readyz      → 503（无上游时必须不就绪，不得伪装 healthy）
#   /            → 200（首页静态介绍区降级）或 503，但必须在超时内返回、不得挂死
#   /robots.txt  → 200 且含 Sitemap 行
#   /sitemap.xml → 503（上游不可用时绝不返回空 sitemap 伪装成功）
#   未知路径     → 404（真实 404，而非 SPA 假 200）
set -eu

IMAGE=${1:?usage: $0 IMAGE}
case "$IMAGE" in
  -*|'') echo "usage: $0 IMAGE" >&2; exit 2 ;;
esac

container_id=""
cleanup() {
  [ -z "$container_id" ] || docker rm -f "$container_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# 无网络、无卷、无密钥启动；CC_PB_INTERNAL_URL 指向不可达地址，使「无上游」成为确定条件
container_id="$(docker run --detach --network none \
  -e CC_PB_INTERNAL_URL=http://127.0.0.1:9 \
  "$IMAGE")"

# 等待服务开始监听（HEALTHCHECK 定义在 compose 侧而非镜像内，这里自行轮询；
# 容器内没有 curl，用镜像自带的 node 探测 loopback）
ready=0
attempt=0
while [ "$attempt" -lt 30 ]; do
  if docker exec "$container_id" node -e '
    fetch("http://127.0.0.1:3100/healthz", { signal: AbortSignal.timeout(2000) })
      .then((res) => process.exit(res.status === 200 ? 0 : 1))
      .catch(() => process.exit(1));
  '; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "ERROR: public-web 容器 30 秒内未在 3100 监听" >&2
  docker logs --tail=60 "$container_id" 2>&1 || true
  exit 1
fi

# 端点断言（busybox wget 无法可靠区分 404/503，统一用 node fetch 校验状态码与正文）
assertions_failed=0
docker exec -i "$container_id" node <<'NODE' || assertions_failed=1
const base = 'http://127.0.0.1:3100';

async function expectStatus(path, expected) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(10000) });
  const body = await res.text();
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(res.status)) {
    throw new Error(path + ': 期望 ' + allowed.join('/') + '，实际 ' + res.status);
  }
  return body;
}

async function main() {
  await expectStatus('/healthz', 200);
  await expectStatus('/readyz', 503);
  // 首页韧性：静态介绍仍在 → 降级 200；整页不可用 → 503。两者都合法，挂死不合法
  await expectStatus('/', [200, 503]);
  const robots = await expectStatus('/robots.txt', 200);
  if (!/^Sitemap: \S+\/sitemap\.xml\s*$/m.test(robots)) {
    throw new Error('/robots.txt: 缺少 Sitemap 行');
  }
  await expectStatus('/sitemap.xml', 503);
  await expectStatus('/definitely-not-a-page', 404);
  console.log('public-web smoke assertions passed');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
NODE
if [ "$assertions_failed" -ne 0 ]; then
  echo "ERROR: public-web smoke 断言失败" >&2
  docker logs --tail=60 "$container_id" 2>&1 || true
  exit 1
fi

# 全部断言通过后容器应仍在运行（不得在断言期间崩溃退出）
test "$(docker inspect --format '{{.State.Running}}' "$container_id")" = true
