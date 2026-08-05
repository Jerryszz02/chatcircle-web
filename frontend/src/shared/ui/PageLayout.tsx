import type { ReactNode } from 'react';

/**
 * 页面布局：统一容器宽度与内边距（360px 无横向滚动，PRD §13），
 * 顶部可选分区标识 + 页面标题 + 操作区。
 * 桌面端管理页可传 wide 放宽到 1200px。
 */
export function PageLayout({
  section,
  title,
  actions,
  wide = false,
  children,
}: {
  /** 所属端：参与者端 / 机构管理端 / 超级管理端。 */
  section?: string;
  title?: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <main className={`page${wide ? ' page-wide' : ''}`}>
      {section ? <p className="page-section">{section}</p> : null}
      {title || actions ? (
        <header className="page-header">
          {title ? <h1 className="page-title">{title}</h1> : <span />}
          {actions}
        </header>
      ) : null}
      {children}
    </main>
  );
}
