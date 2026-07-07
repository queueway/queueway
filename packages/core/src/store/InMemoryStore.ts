import { IStore } from './IStore';
import { Job } from '../types';

/**
 * Zero-config default store. Keeps jobs in memory (process lifetime only).
 * Great for local dev / testing; use PostgreSQLStore or SQLiteStore for
 * anything that needs to survive a restart.
 */
export class InMemoryStore implements IStore {
  private jobs: Map<string, Job> = new Map();

  async initialize(): Promise<void> {
    console.log('✅ In-Memory store ready (data will not persist across restarts)');
  }

  async saveJob(job: Job): Promise<void> {
    this.jobs.set(job.id, job);
  }

  async getJob(jobId: string): Promise<Job | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async updateJob(jobId: string, status: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = status as Job['status'];
    this.jobs.set(jobId, job);
  }

  async getAllJobs(status?: string, limit?: number): Promise<Job[]> {
    let jobs = Array.from(this.jobs.values());

    if (status) {
      jobs = jobs.filter((j) => j.status === status);
    }

    jobs = jobs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (limit) {
      jobs = jobs.slice(0, limit);
    }

    return jobs;
  }
}
