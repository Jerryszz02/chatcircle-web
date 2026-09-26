/**
 * 公开页渲染服务配置（环境变量解析；无任何密钥）。
 */

export interface PublicServerConfig {
  /** 监听端口（默认 3100）。 */
  port: number;
  /** 站点对外 origin（canonical/OG/sitemap 用，默认 https://chatcircle.empact.cn）。 */
  siteOrigin: string;
  /** PocketBase 内部地址（默认 http://127.0.0.1:8090）。 */
  pbBaseUrl: string;
  /** 单请求上游超时毫秒数（默认 5000）。 */
  fetchTimeoutMs: number;
  /** 同时在飞的上游请求上限（默认 32）。 */
  maxInflight: number;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadPublicServerConfig(
  env: Record<string, string | undefined> = process.env,
): PublicServerConfig {
  return {
    port: intFromEnv(env.PORT, 3100),
    siteOrigin: (env.CC_SITE_ORIGIN || 'https://chatcircle.empact.cn').replace(/\/+$/, ''),
    pbBaseUrl: (env.CC_PB_INTERNAL_URL || 'http://127.0.0.1:8090').replace(/\/+$/, ''),
    fetchTimeoutMs: intFromEnv(env.CC_PUBLIC_FETCH_TIMEOUT_MS, 5000),
    maxInflight: intFromEnv(env.CC_PUBLIC_MAX_INFLIGHT, 32),
  };
}
