import { useEffect, useState, type ReactNode } from 'react';

/**
 * 仅在浏览器挂载后渲染 children 的客户端岛屿边界。
 *
 * 会话敏感组件（HeaderActions、MyPairingCard 等依赖 localStorage 会话的模块）
 * 不得进入服务端渲染图：服务端与 hydrate 首帧一律渲染 placeholder，
 * 挂载后（useEffect 置位）再切换为真实内容，保证 SSR HTML 与首帧逐字节一致。
 */
export function ClientOnly({
  placeholder = null,
  children,
}: {
  /** 未挂载时（含 SSR 输出）渲染的占位内容。 */
  placeholder?: ReactNode;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted ? <>{children}</> : <>{placeholder}</>;
}
