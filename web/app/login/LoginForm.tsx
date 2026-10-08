'use client';

import { useActionState } from 'react';
import { Loader2 } from 'lucide-react';
import { login, type LoginState } from './actions';

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <form action={action} className="login-form">
      <label className="field">
        <span>Username</span>
        {/* The form resets after each attempt; keep what the person typed as their username. */}
        <input name="username" autoComplete="username" required autoFocus key={state.username ?? ''} defaultValue={state.username ?? ''} />
      </label>
      <label className="field">
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <button className="btn btn-primary btn-block" disabled={pending}>
        {pending ? <><Loader2 size={16} className="spin" aria-hidden /> Signing in…</> : 'Sign in'}
      </button>
    </form>
  );
}
