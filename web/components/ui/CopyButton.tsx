'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useToast } from './Providers';

export function CopyButton({ value, what }: { value: string; what: string }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <button type="button" className="btn btn-ghost btn-sm icon-btn" aria-label={`Copy ${what}`} title={`Copy ${what}`}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true); toast({ title: `${what} copied` });
          setTimeout(() => setDone(false), 1600);
        }, () => toast({ title: 'Could not copy', sub: 'Your browser blocked clipboard access.', tone: 'error' }));
      }}>
      {done ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  );
}
