import type { ReactNode } from 'react';

/** 卡片容器：移动端单列，桌面端由父布局决定栅格。 */
export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  /** 卡片右上角操作区（按钮/链接）。 */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`cc-card${className ? ` ${className}` : ''}`}>
      {title || actions ? (
        <header className="cc-card-header">
          {title ? <h2 className="cc-card-title">{title}</h2> : <span />}
          {actions}
        </header>
      ) : null}
      <div className="cc-card-body">{children}</div>
    </section>
  );
}
