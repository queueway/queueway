'use client';

import { useState } from 'react';
import { AuthLayout } from './AuthLayout';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }
      onSuccess();
    } catch {
      setError('Could not reach the server');
    } finally {
      setLoading(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch('/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setForgotSent(true);
    } finally {
      setLoading(false);
    }
  }

  if (forgotMode) {
    return (
      <AuthLayout title="Reset your password" subtitle="Enter your email and we'll send you a reset link.">
        {forgotSent ? (
          <p className="text-sm text-muted-foreground">
            If that email has an account, a reset link is on its way. Check your inbox.
          </p>
        ) : (
          <form onSubmit={handleForgot} className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Email</label>
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Sending…' : 'Send reset link'}
            </Button>
          </form>
        )}
        <button
          type="button"
          className="mt-3 text-xs text-blue-400 hover:underline"
          onClick={() => {
            setForgotMode(false);
            setForgotSent(false);
          }}
        >
          ← Back to login
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Log in to Queueway">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Email</label>
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Password</label>
          <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
      <button type="button" className="mt-3 text-xs text-blue-400 hover:underline" onClick={() => setForgotMode(true)}>
        Forgot password?
      </button>
    </AuthLayout>
  );
}
