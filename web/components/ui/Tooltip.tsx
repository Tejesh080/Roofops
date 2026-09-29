'use client';

import { useId, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

/** Hover- and keyboard-accessible tooltip. The trigger gets aria-describedby while it is shown. */
export function Tooltip({ content, children, align = 'center' }: { content: React.ReactNode; children: (props: TriggerProps) => React.ReactNode; align?: 'center' | 'end' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const props: TriggerProps = {
    'aria-describedby': open ? id : undefined,
    onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false),
    onFocus: () => setOpen(true), onBlur: () => setOpen(false),
    onKeyDown: (e) => { if (e.key === 'Escape') setOpen(false); },
  };
  return (
    <span className="tip-wrap">
      {children(props)}
      <AnimatePresence>
        {open && (
          <motion.span id={id} role="tooltip" className={`tip ${align === 'end' ? 'end' : ''}`}
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 2 }} transition={{ duration: 0.14 }}>
            {content}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

export interface TriggerProps {
  'aria-describedby'?: string;
  onMouseEnter: () => void; onMouseLeave: () => void; onFocus: () => void; onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}
