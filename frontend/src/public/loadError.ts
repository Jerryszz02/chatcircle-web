import type { PublicLoadError } from './types';

/** 把任意错误收窄为公开页视图的错误口径 { status, message }（不泄漏内部细节）。 */
export function toPublicLoadError(err: unknown): PublicLoadError {
  if (err && typeof err === 'object') {
    const status =
      'status' in err && typeof (err as { status: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 0;
    const message =
      'message' in err &&
      typeof (err as { message: unknown }).message === 'string' &&
      (err as { message: string }).message !== ''
        ? (err as { message: string }).message
        : '请求失败，请稍后重试';
    return { status, message };
  }
  return { status: 0, message: '请求失败，请稍后重试' };
}
