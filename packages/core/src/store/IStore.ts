import { Job, ComponentHealth } from "../types";

export interface IStore {
  initialize(): Promise<void>;
  saveJob(job: Job): Promise<void>;
  getJob(jobId: string): Promise<Job | null>;
  updateJob(jobId: string, status: string, attempts?: number): Promise<void>;
  getAllJobs(status?: string, limit?: number): Promise<Job[]>;
  /**
   * Called once on Queueway.start(). Persistent stores (SQLite, PostgreSQL)
   * should find any jobs left in 'pending' | 'processing' | 'retrying' from
   * a previous run (crash/restart) and return them so they get re-queued.
   * Non-persistent stores (InMemoryStore) should simply return [] — there's
   * nothing to recover since the store itself started empty this run.
   */
  recoverStuckJobs(): Promise<Job[]>;
  /** Real, live check — actually verifies the database connection is working right now. */
  checkHealth(): Promise<ComponentHealth>;
}
