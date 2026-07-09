'use client';

import { useEffect, useState, useCallback } from 'react';
import { Activity, CheckCircle2, Clock, XCircle, Circle, LogOut } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SignupForm } from '@/components/auth/SignupForm';
import { LoginForm } from '@/components/auth/LoginForm';
import { ResetPasswordForm } from '@/components/auth/ResetPasswordForm';
import { ThemeToggle } from '@/components/ThemeToggle';
import { PoweredByFooter } from '@/components/PoweredByFooter';

type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'retrying' | 'archived';

interface Job {
  id: string;
  eventName: string;
  data: unknown;
  status: JobStatus;
  attempts: number;
  createdAt: string;
}

interface Stats {
  jobs: Record<JobStatus, number>;
  total: number;
}

interface ComponentHealth {
  status: 'up' | 'down';
  latency?: number;
  error?: string;
}

interface Health {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  components: {
    broker: ComponentHealth;
    database: ComponentHealth;
    api: ComponentHealth;
  };
}

const statCards = [
  { key: 'pending', label: 'Pending', icon: Clock, color: 'text-amber-400' },
  { key: 'processing', label: 'Processing', icon: Activity, color: 'text-blue-400' },
  { key: 'completed', label: 'Completed', icon: CheckCircle2, color: 'text-emerald-400' },
  { key: 'failed', label: 'Failed', icon: XCircle, color: 'text-red-400' },
] as const;

const FILTERS: Array<'all' | JobStatus> = ['all', 'pending', 'processing', 'completed', 'failed', 'retrying'];

type View = 'loading' | 'signup' | 'login' | 'reset' | 'dashboard';

export default function DashboardPage() {
  const [view, setView] = useState<View>('loading');
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);

  const checkAuth = useCallback(async () => {
    try {
      const meRes = await fetch('/auth/me');
      if (meRes.ok) {
        const data = await meRes.json();
        setUserEmail(data.email);
        setView('dashboard');
        return;
      }
    } catch {
      /* fall through to signup/login check */
    }
    try {
      const status = await fetch('/auth/status').then((r) => r.json());
      setView(status.hasAccount ? 'login' : 'signup');
    } catch {
      setView('login');
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('resetToken');
    if (token) {
      setResetToken(token);
      setView('reset');
      return;
    }
    checkAuth();
  }, [checkAuth]);

  async function handleLogout() {
    await fetch('/auth/logout', { method: 'POST' });
    setUserEmail(null);
    setView('login');
  }

  if (view === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <img src="/logo.svg" alt="Queueway" className="h-16 w-auto opacity-70" />
      </main>
    );
  }

  if (view === 'signup') return <SignupForm onSuccess={checkAuth} />;
  if (view === 'login') return <LoginForm onSuccess={checkAuth} />;
  if (view === 'reset' && resetToken) {
    return (
      <ResetPasswordForm
        token={resetToken}
        onSuccess={() => {
          window.history.replaceState({}, '', '/');
          setResetToken(null);
          setView('login');
        }}
      />
    );
  }

  return <DashboardContent userEmail={userEmail} onLogout={handleLogout} />;
}

function DashboardContent({ userEmail, onLogout }: { userEmail: string | null; onLogout: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | JobStatus>('all');
  const [retrying, setRetrying] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const jobsUrl = filter === 'all' ? '/queueway/jobs?limit=25' : `/queueway/jobs?status=${filter}&limit=25`;
      const [statsRes, jobsRes, healthRes] = await Promise.all([
        fetch('/queueway/stats').then((r) => r.json()),
        fetch(jobsUrl).then((r) => r.json()),
        fetch('/queueway/health').then((r) => r.json()),
      ]);
      setStats(statsRes);
      setJobs(jobsRes);
      setHealth(healthRes);
      setError(null);
    } catch (err: any) {
      setError(err.message ?? 'Could not reach Queueway API');
    }
  }, [filter]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function handleRetry(jobId: string) {
    setRetrying(jobId);
    try {
      await fetch(`/queueway/jobs/${jobId}/retry`, { method: 'POST' });
      await refresh();
    } finally {
      setRetrying(null);
    }
  }

  const healthComponents: Array<{ key: keyof Health['components']; label: string }> = [
    { key: 'broker', label: 'Broker' },
    { key: 'database', label: 'Database' },
    { key: 'api', label: 'API' },
  ];

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:space-y-6 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 sm:gap-3">
          <img src="/logo.svg" alt="Queueway" className="h-9 w-auto shrink-0 sm:h-12" />
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold sm:text-xl">
              <span className="bg-gradient-to-r from-orange-400 via-purple-400 to-blue-400 bg-clip-text text-transparent">
                Queueway
              </span>{' '}
              Dashboard
            </h1>
            <p className="text-xs text-muted-foreground sm:text-sm">Auto-refreshes every 3 seconds</p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 sm:justify-end sm:gap-3">
          {userEmail && <span className="truncate text-xs text-muted-foreground">{userEmail}</span>}
          <div className="flex shrink-0 items-center gap-2">
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={onLogout}>
              <LogOut className="mr-1 h-3.5 w-3.5" /> Logout
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <Card className="border-red-900 bg-red-950/30">
          <CardContent className="p-4 text-sm text-red-400">
            Could not reach Queueway API: {error} — make sure the core server is running.
          </CardContent>
        </Card>
      )}

      <div>
        <h2 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">System Health</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {healthComponents.map(({ key, label }) => {
            const c = health?.components?.[key];
            const isUp = c?.status === 'up';
            return (
              <Card key={key}>
                <CardContent className="flex items-center justify-between p-3 sm:p-4">
                  <div>
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className="mt-1 flex items-center gap-2 text-sm font-medium">
                      <Circle className={`h-2.5 w-2.5 ${isUp ? 'fill-emerald-400 text-emerald-400' : 'fill-red-400 text-red-400'}`} />
                      {isUp ? 'Up' : 'Down'}
                    </div>
                    {c?.error && <div className="mt-1 text-xs text-red-400">{c.error}</div>}
                  </div>
                  {c?.latency !== undefined && (
                    <div className="text-xs text-muted-foreground">{c.latency}ms</div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Jobs Overview</h2>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
          {statCards.map(({ key, label, icon: Icon, color }) => (
            <Card key={key}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 pb-1 sm:p-6 sm:pb-2">
                <CardTitle className="text-xs sm:text-sm">{label}</CardTitle>
                <Icon className={`h-3.5 w-3.5 sm:h-4 sm:w-4 ${color}`} />
              </CardHeader>
              <CardContent className="p-3 pt-0 sm:p-6 sm:pt-0">
                <div className={`text-lg font-bold sm:text-2xl ${color}`}>{stats?.jobs?.[key] ?? 0}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader className="p-3 sm:p-6">
          <CardTitle>Jobs</CardTitle>
          <div className="mt-3 inline-flex flex-wrap items-center justify-center gap-1 rounded-lg bg-muted p-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-all ${
                  filter === f
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="p-3 pt-0 sm:p-6 sm:pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job ID</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Data</TableHead>
                <TableHead>Created</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    No jobs in this view — publish something, or try a different filter!
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-mono text-xs">{job.id.slice(0, 8)}…</TableCell>
                    <TableCell>{job.eventName}</TableCell>
                    <TableCell>
                      <Badge variant={job.status}>{job.status}</Badge>
                    </TableCell>
                    <TableCell>{job.attempts}</TableCell>
                    <TableCell
                      className="max-w-[200px] truncate font-mono text-xs text-muted-foreground"
                      title={JSON.stringify(job.data)}
                    >
                      {JSON.stringify(job.data)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(job.createdAt).toLocaleTimeString()}
                    </TableCell>
                    <TableCell>
                      {job.status === 'failed' && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={retrying === job.id}
                          onClick={() => handleRetry(job.id)}
                        >
                          {retrying === job.id ? 'Retrying…' : 'Retry'}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        {health ? (
          <>
            Overall status: {health.status} · Last checked: {new Date(health.timestamp).toLocaleTimeString()}
          </>
        ) : (
          'Checking health…'
        )}
      </p>

      <PoweredByFooter />
    </main>
  );
}
