import { useEffect, useId } from 'react';
import type { ReactNode } from 'react';

/**
 * 模态框（移动端底部弹出样式，桌面居中）。
 * 可访问性：role="dialog" + aria-modal + 标题关联；Escape 与遮罩点击关闭。
 * 用于二次确认等场景（如敏感导出确认，AC-17）。
 */

export interface ModalProps {
  open: boolean;
  /** 标题（同时作为 aria-labelledby 目标）。 */
  title: string;
  onClose: () => void;
  /** 底部操作区。 */
  footer?: ReactNode;
  children: ReactNode;
}

export function Modal({ open, title, onClose, footer, children }: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="cc-modal-overlay" onClick={onClose}>
      <div
        className="cc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cc-modal-header">
          <h2 className="cc-modal-title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="cc-modal-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="cc-modal-body">{children}</div>
        {footer ? <footer className="cc-modal-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
