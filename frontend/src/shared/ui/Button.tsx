import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * 通用按钮（移动优先：触控高度 ≥44px，PRD §13）。
 * loading 时禁用并阻止重复点击——与服务端幂等互为防线，不互相替代（AC-20、test-plan §2）。
 */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  /** 块级（占满一行，移动端表单主操作常用）。 */
  block?: boolean;
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  block = false,
  loading = false,
  disabled,
  type = 'button',
  children,
  className,
  ...rest
}: ButtonProps) {
  const classes = ['cc-btn', `cc-btn-${variant}`, block ? 'cc-btn-block' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading}
      {...rest}
    >
      {loading ? '处理中…' : children}
    </button>
  );
}
