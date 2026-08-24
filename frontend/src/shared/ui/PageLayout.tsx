import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * 页面布局：统一容器宽度与内边距（360px 无横向滚动，PRD §13），
 * 顶部可选返回首页链接（左上角）+ 分区标识 + 页面标题 + 操作区。
 * 桌面端管理页可传 wide 放宽到 1200px。
 */
export function PageLayout({
  section,
  title,
  actions,
  backTo,
  wide = false,
  className,
  children,
}: {
  /** 所属端：参与者端 / 机构管理端 / 超级管理端。 */
  section?: string;
  title?: ReactNode;
  actions?: ReactNode;
  /** 传入后在左上角渲染「返回首页」链接。 */
  backTo?: string;
  wide?: boolean;
  /** 附加在根元素上的类名（如参与者端页面底色标记 ccp-root）。 */
  className?: string;
  children: ReactNode;
}) {
  return (
    <main className={`page${wide ? ' page-wide' : ''}${className ? ` ${className}` : ''}`}>
      {backTo ? (
        <div className="page-back">
          <Link to={backTo} className="cc-btn cc-btn-secondary">
            返回首页
          </Link>
        </div>
      ) : null}
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
