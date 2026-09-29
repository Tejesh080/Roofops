'use client';

import { Sparkles } from 'lucide-react';

export const ASK_EVENT = 'roofops:ask';

/** Opens the copilot with a question about what the user is looking at. */
export function AskButton({ question, text = 'Ask about this project' }: { question: string; text?: string }) {
  return (
    <button type="button" className="btn btn-sm" onClick={() => window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: question }))}>
      <Sparkles size={14} color="var(--accent)" aria-hidden /> {text}
    </button>
  );
}
