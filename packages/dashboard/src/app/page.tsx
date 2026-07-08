'use client';

import { useEffect, useState } from 'react';
import { Activity, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'retrying' | 'archived';

interface Job {
  id: string;
  eventName: string;
  status: JobStatus;
  attempts: number;
  createdAt: string;
}

interface Stats {
  jobs: Record<JobStatus, number>;
  total: number;
}

interface Health {
  status: string;
  timestamp: string;
}

const statCards = [
  { key: 'pending', label: 'Pending', icon: Clock, color: 'text-amber-400' },
  { key: 'processing', label: 'Processing', icon: Activity, color: 'text-blue-400' },
  { key: 'completed', label: 'Completed', icon: CheckCircle2, color: 'text-emerald-400' },
  { key: 'failed', label: 'Failed', icon: XCircle, color: 'text-red-400' },
] as const;

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function refresh() {
      try {
        const [statsRes, jobsRes, healthRes] = await Promise.all([
          fetch('/queueway/stats').then((r) => r.json()),
          fetch('/queueway/jobs?limit=25').then((r) => r.json()),
          fetch('/queueway/health').then((r) => r.json()),
        ]);
        setStats(statsRes);
        setJobs(jobsRes);
        setHealth(healthRes);
        setError(null);
      } catch (err: any) {
        setError(err.message ?? 'Could not reach Queueway API');
      }
    }

    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <main className="mx-auto max-w-6xl p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">🚀 Queueway Dashboard</h1>
        <p className="text-sm text-muted-foreground">Auto-refreshes every 3 seconds</p>
      </div>

      {error && (
        <Card className="border-red-900 bg-red-950/30">
          <CardContent className="p-4 text-sm text-red-400">
            Could not reach Queueway API: {error} — make sure the core server is running on port 3000.
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {statCards.map(({ key, label, icon: Icon, color }) => (
          <Card key={key}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle>{label}</CardTitle>
              <Icon className={`h-4 w-4 ${color}`} />
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${color}`}>
                {stats?.jobs?.[key] ?? 0}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job ID</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No jobs yet — publish something!
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
                    <TableCell className="text-muted-foreground">
                      {new Date(job.createdAt).toLocaleTimeString()}
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
            <span className="text-emerald-400">●</span> Status: {health.status} · Last checked:{' '}
            {new Date(health.timestamp).toLocaleTimeString()}
          </>
        ) : (
          'Checking health…'
        )}
      </p>
    </main>
  );
}
