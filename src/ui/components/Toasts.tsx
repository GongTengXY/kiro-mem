/** @jsxImportSource preact */
/**
 * Transient confirmations for reversible actions — pin, whose effect is otherwise
 * invisible here. Not used for delete: that has no undo, so it gets a modal stating
 * what will be destroyed. The container is always mounted as an `aria-live` region,
 * so announcements reach assistive tech.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { AlertTriangle, Check } from 'lucide-preact';
import { useT } from '../i18n';

export type ToastTone = 'ok' | 'danger';

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}

const TTL_MS = 2600;
const MAX_VISIBLE = 3;

export function useToasts(ttlMs = TTL_MS) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef<number[]>([]);

  // A pending timer must not outlive the component: it would setState on an unmounted tree.
  useEffect(
    () => () => {
      for (const handle of timers.current) clearTimeout(handle);
      timers.current = [];
    },
    [],
  );

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (text: string, tone: ToastTone = 'ok') => {
      const id = ++seq.current;
      setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { id, text, tone }]);
      const handle = window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        timers.current = timers.current.filter((h) => h !== handle);
      }, ttlMs);
      timers.current.push(handle);
    },
    [ttlMs],
  );

  return { toasts, push, dismiss };
}

export function Toasts({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  const t = useT();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`toast toast-${toast.tone}`}
          title={t.dismiss}
          onClick={() => onDismiss(toast.id)}
        >
          <span className="toast-icon">
            {toast.tone === 'danger' ? <AlertTriangle size={15} /> : <Check size={15} />}
          </span>
          <span className="toast-text">{toast.text}</span>
        </button>
      ))}
    </div>
  );
}
