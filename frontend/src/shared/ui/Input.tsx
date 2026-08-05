import { useId } from 'react';
import type { InputHTMLAttributes } from 'react';

/**
 * 表单输入框（可访问性：label 关联、错误提示 aria-live，test-plan §9 无障碍核查项）。
 * font-size 16px 避免 iOS/微信内置浏览器聚焦自动放大（PRD §13 兼容性）。
 */

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 标签文案（必填，保证每个控件都有可访问名称）。 */
  label: string;
  /** 字段级错误信息；非空即展示并标记 aria-invalid。 */
  error?: string;
  /** 辅助说明（如用户名规则提示）。 */
  hint?: string;
}

export function Input({ label, error, hint, id, required, className, ...rest }: InputProps) {
  const autoId = useId();
  const inputId = id ?? `input-${autoId}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={`cc-field${error ? ' cc-field-error' : ''}${className ? ` ${className}` : ''}`}>
      <label className="cc-label" htmlFor={inputId}>
        {label}
        {required ? (
          <span className="cc-required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      <input
        id={inputId}
        className="cc-input"
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint ? (
        <p className="cc-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="cc-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
