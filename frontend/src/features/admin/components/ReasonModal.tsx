import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Button, Modal } from '../../../shared/ui';

/**
 * 带原因输入的确认弹窗（补签/撤销签到、报名取消与回退、答卷作废、敏感导出等场景）。
 * reasonRequired=true 时空原因禁止提交（FR-CHK-005、FR-REG-008、FR-SUR-010、AC-17）。
 */
export function ReasonModal({
  open,
  title,
  confirmLabel = '确认',
  confirmVariant = 'primary',
  reasonLabel = '原因',
  reasonRequired = false,
  submitting = false,
  onClose,
  onSubmit,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel?: string;
  confirmVariant?: 'primary' | 'secondary' | 'danger';
  reasonLabel?: string;
  /** 原因是否必填（高风险操作强制，见 security-privacy §8.1）。 */
  reasonRequired?: boolean;
  submitting?: boolean;
  onClose: () => void;
  /** reason 为去除首尾空白后的值；选填时可能为空字符串。 */
  onSubmit: (reason: string) => void | Promise<void>;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = reason.trim();
    if (reasonRequired && !trimmed) {
      setError(`${reasonLabel}必填`);
      return;
    }
    setError('');
    try {
      await onSubmit(trimmed);
      setReason('');
    } catch {
      // 提交失败：保留已填原因便于修正重试，错误信息由调用方在弹窗 children 内展示
    }
  };

  const handleClose = () => {
    setReason('');
    setError('');
    onClose();
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={handleClose}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={submitting}>
            取消
          </Button>
          <Button
            variant={confirmVariant}
            type="submit"
            form="cc-reason-form"
            loading={submitting}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form id="cc-reason-form" onSubmit={handleSubmit}>
        {children}
        <div className={`cc-field${error ? ' cc-field-error' : ''}`}>
          <label className="cc-label" htmlFor="cc-reason-input">
            {reasonLabel}
            {reasonRequired ? (
              <span className="cc-required" aria-hidden="true">
                *
              </span>
            ) : (
              <span className="cc-hint-inline">（选填）</span>
            )}
          </label>
          <textarea
            id="cc-reason-input"
            className="cc-input cc-textarea"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={error ? true : undefined}
          />
          {error ? (
            <p className="cc-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </form>
    </Modal>
  );
}
