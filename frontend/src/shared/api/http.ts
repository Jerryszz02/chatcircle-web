import { ClientResponseError } from 'pocketbase';
import type PocketBase from 'pocketbase';
import type { SendOptions } from 'pocketbase';

/**
 * 自定义端点 fetch 包装（technical-design §5.5）。
 *
 * pb_hooks 的自定义端点（/api/cc/*）不在 pb.collection() 类型化封装范围内，
 * 统一经本模块访问：自动携带当前 client 的 auth token、统一 JSON 编解码、
 * 统一把 PocketBase ClientResponseError / 网络错误 / 中止错误规范化为 ApiError。
 */

/** 规范化后的 API 错误码。 */
export type ApiErrorCode = 'HTTP_ERROR' | 'NETWORK_ERROR' | 'ABORTED' | 'INVALID_RESPONSE';

/** 规范化 API 错误：UI 层只需关心 code/status/message，不必识别 SDK 内部错误类型。 */
export class ApiError extends Error {
  /** HTTP 状态码；网络层错误为 0。 */
  readonly status: number;
  readonly code: ApiErrorCode;
  /** PocketBase 返回的字段级错误明细（response.data），无则为 undefined。 */
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code: ApiErrorCode,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_MESSAGE = '请求失败，请稍后重试';
const NETWORK_MESSAGE = '无法连接服务器，请检查网络后重试';

/** 把任意异常规范化为 ApiError（幂等，已是 ApiError 则原样返回）。 */
export function normalizeApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ClientResponseError) {
    if (err.isAbort) {
      return new ApiError('请求已取消', 0, 'ABORTED');
    }
    if (err.status === 0) {
      return new ApiError(NETWORK_MESSAGE, 0, 'NETWORK_ERROR');
    }
    const response = err.response as { message?: string; data?: Record<string, unknown> };
    const message =
      typeof response?.message === 'string' && response.message !== ''
        ? response.message
        : DEFAULT_MESSAGE;
    return new ApiError(message, err.status, 'HTTP_ERROR', response?.data);
  }
  if (err instanceof Error) {
    return new ApiError(err.message || DEFAULT_MESSAGE, 0, 'NETWORK_ERROR');
  }
  return new ApiError(DEFAULT_MESSAGE, 0, 'NETWORK_ERROR');
}

/**
 * 基础请求：调用 client.send（自动附带 auth token 与 JSON 处理），错误统一规范化。
 * path 为 PocketBase 相对路径（如 '/api/cc/health'）。
 */
export async function apiFetch<T>(
  client: PocketBase,
  path: string,
  options: SendOptions = {},
): Promise<T> {
  try {
    return await client.send<T>(path, options);
  } catch (err) {
    throw normalizeApiError(err);
  }
}

export async function apiGet<T>(
  client: PocketBase,
  path: string,
  options: SendOptions = {},
): Promise<T> {
  return apiFetch<T>(client, path, { ...options, method: 'GET' });
}

/**
 * POST 封装（幂等安全占位约定，technical-design §5.5「报名/签到/问卷接口幂等」、AC-20）：
 * - 重试/重复点击不产生重复正式记录由服务端唯一约束 + 「已存在则返回现状」语义兜底，
 *   前端不做自动重试，也不在前端去重；
 * - 预留幂等键：传入 idempotencyKey 时以 `Idempotency-Key` 请求头发送，
 *   后端 hooks 落地后据此识别重试请求（V1 服务端以唯一约束为准，header 为前向兼容占位）。
 */
export async function apiPost<T>(
  client: PocketBase,
  path: string,
  body?: unknown,
  options: SendOptions & { idempotencyKey?: string } = {},
): Promise<T> {
  const { idempotencyKey, headers, ...rest } = options;
  return apiFetch<T>(client, path, {
    ...rest,
    method: 'POST',
    body: body === undefined ? {} : body,
    headers: {
      ...(headers ?? {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
  });
}

/** 健康检查示例端点（backend pb_hooks/main.pb.js 已提供）。 */
export function health(client: PocketBase): Promise<unknown> {
  return apiGet(client, '/api/cc/health');
}

/**
 * 管理员邀请码注册（FR-ORG-002/003、AC-02）：邀请码明文 + 用户名 + 密码，
 * 服务端单事务校验邀请码并创建 admin_accounts；并发使用同一邀请码只能成功一次。
 * 请求体契约字段为 invite_code（与后端 auth.pb.js 一致，已对齐）。
 */
export function registerAdmin(
  client: PocketBase,
  input: { invite_code: string; username: string; password: string },
): Promise<unknown> {
  return apiPost(client, '/api/cc/auth/admin-register', input);
}
