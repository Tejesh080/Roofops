'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { CheckCircle2, CircleAlert } from 'lucide-react';

interface Toast { id: number; title: string; sub?: string; tone?: 'ok' | 'error' }
const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function Providers({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((cur) => [...cur, { ...t, id }]);
    setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
      <ToastCtx.Provider value={push}>
        {children}
        <div className="toasts" role="status" aria-live="polite">
          <AnimatePresence>
            {toasts.map((t) => (
              <motion.div key={t.id} className="toast" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }}>
                {t.tone === 'error' ? <CircleAlert size={16} aria-hidden /> : <CheckCircle2 size={16} aria-hidden />}
                <div><div className="t-title">{t.title}</div>{t.sub && <div className="t-sub">{t.sub}</div>}</div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </ToastCtx.Provider>
    </MotionConfig>
  );
}
