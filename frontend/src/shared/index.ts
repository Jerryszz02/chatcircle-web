/**
 * 共享层统一出口（technical-design §5.2：src/shared/ 为跨端共享代码）。
 * 三个分区（features/participant、features/admin、features/superadmin）从这里引用
 * PB client、record 类型、枚举、通用 UI 组件与 metrics 注册表。
 */
export * from './pocketbase';
export * from './auth';
export * from './guards';
export * from './api';
export * from './metrics';
export * from './ui';
