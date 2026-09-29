import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/auth';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in · RoofOps' };

export default async function LoginPage() {
  if (await currentSession()) redirect('/');
  return (
    <main className="login">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 12 12 4l9 8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M6 10.5V20h12v-9.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>
          </span>
          <div>
            <div className="login-title">RoofOps</div>
            <div className="login-sub">Operations Control Centre</div>
          </div>
        </div>
        <p className="login-note">Demo environment · synthetic data for a fictional roofing business.</p>
        <LoginForm />
      </div>
    </main>
  );
}
