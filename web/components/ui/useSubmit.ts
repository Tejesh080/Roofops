'use client';

import { startTransition, useEffect, useRef, type FormEvent } from 'react';

/**
 * Submit a server-action form WITHOUT React's automatic reset: React clears an action form after every submission, so a
 * refused one (a reason too short, a crew clash, a duplicate, a database that did not answer) would wipe what the person
 * typed. Callers reset the form themselves after a success. A second click before the button disables is ignored; the
 * clicked button's name/value (e.g. action=start) travels as the submitter.
 */
export function useSubmit(action: (f: FormData) => void, pending: boolean) {
  const busy = useRef(false);
  useEffect(() => { if (!pending) busy.current = false; }, [pending]);
  return (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy.current) return;
    busy.current = true;
    const data = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
    startTransition(() => action(data));
  };
}
