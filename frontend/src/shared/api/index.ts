/** 类型化 API 层统一出口：import { collectionsForRole, apiPost } from '@/shared/api'; */
export * from './types';
export { COLLECTION_NAMES, collections, collectionsForRole } from './collections';
export type { TypedCollections } from './collections';
export {
  ApiError,
  apiFetch,
  apiGet,
  apiPost,
  health,
  normalizeApiError,
  registerAdmin,
} from './http';
export type { ApiErrorCode } from './http';
