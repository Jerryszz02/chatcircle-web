import { createContext, useContext } from 'react';

/** Toast 类型：成功 / 错误 / 信息。 */
export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ToastContextValue {
  /** 弹出一条 Toast，自动消失。 */
  toast: (message: string, kind?: ToastKind) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

/** 在 ToastProvider 内任意组件调用：const { toast } = useToast(); */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast 必须在 <ToastProvider> 内使用');
  }
  return ctx;
}
