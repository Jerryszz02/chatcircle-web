import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ToastContext, type ToastItem, type ToastKind } from './toast-context';

/** Toast 自动消失时长（毫秒）。 */
const TOAST_DURATION = 3000;

/**
 * 全局轻提示（aria-live 播报，屏幕阅读器可读）。
 * 在应用根部挂载一次：<ToastProvider><App /></ToastProvider>，组件内用 useToast() 触发。
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const toast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="cc-toast-viewport" aria-live="polite" role="status">
        {items.map((t) => (
          <div key={t.id} className={`cc-toast cc-toast-${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
