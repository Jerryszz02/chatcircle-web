import { createContext, useContext, type ReactNode } from 'react';

/**
 * 公开页导航原语（SSR 安全，替代 react-router 的 Link/NavLink）。
 *
 * 公开页一律使用 document navigation（纯 <a>），head 元信息因此始终正确，
 * 服务端渲染与浏览器 hydrate 走同一套组件。
 *
 * 当前路径来源优先级：CurrentPathContext > window.location.pathname > '/'。
 * active 判定复刻 NavLink 语义：end 精确匹配；否则前缀匹配且下一段以 '/' 分隔
 * （/activities 不会在 /activitiesX 上 active，但会在 /activities/past 上 active）。
 * 与原 NavLink 的差异：大小写敏感（与 public/routes.ts 的路由匹配口径一致）。
 */

const CurrentPathContext = createContext<string | null>(null);

/** 提供当前路径（SSR 注入请求路径；SPA 场景缺省回退 window.location）。 */
export function CurrentPathProvider({ value, children }: { value: string; children: ReactNode }) {
  return <CurrentPathContext.Provider value={value}>{children}</CurrentPathContext.Provider>;
}

function resolveCurrentPath(contextValue: string | null): string {
  if (contextValue !== null) return contextValue;
  if (typeof window !== 'undefined' && window.location?.pathname) {
    return window.location.pathname;
  }
  return '/';
}

/** NavLink 语义复刻：end 精确匹配；否则前缀匹配且下一段以 '/' 分隔。 */
function isActivePath(pathname: string, href: string, end?: boolean): boolean {
  if (end) return pathname === href;
  return pathname === href || pathname.startsWith(href === '/' ? '/' : `${href}/`);
}

/** 纯 <a> 导航链接；active 时按 NavLink 惯例加 class 与 aria-current="page"。 */
export function NavAnchor({
  href,
  end,
  className,
  children,
}: {
  href: string;
  end?: boolean;
  className?: string | ((state: { isActive: boolean }) => string | undefined);
  children: ReactNode;
}) {
  const contextValue = useContext(CurrentPathContext);
  const isActive = isActivePath(resolveCurrentPath(contextValue), href, end);
  const resolvedClassName = typeof className === 'function' ? className({ isActive }) : className;
  return (
    <a href={href} className={resolvedClassName} aria-current={isActive ? 'page' : undefined}>
      {children}
    </a>
  );
}
