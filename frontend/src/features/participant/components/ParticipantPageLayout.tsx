import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AccountActions } from './AccountActions';
import { PublicPageLayout } from './PublicPageLayout';

/** Participant forms share the public shell while keeping a comfortable reading width. */
export function ParticipantPageLayout({
  section,
  title,
  actions,
  backTo,
  children,
}: {
  section?: string;
  title?: ReactNode;
  actions?: ReactNode;
  backTo?: string;
  children: ReactNode;
}) {
  return (
    <PublicPageLayout className="ccp-workflow" actions={<AccountActions />}>
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
    </PublicPageLayout>
  );
}
