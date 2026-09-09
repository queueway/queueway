import { Job, ComponentHealth, RecoverOptions } from "../types";

export interface IStore {
  initialize(): Promise<void>;
  saveJob(job: Job): Promise<void>;
  getJob(jobId: string): Promise<Job | null>;
  updateJob(jobId: string, status: string, attempts?: number): Promise<void>;
  getAllJobs(status?: string, limit?: number): Promise<Job[]>;
  /**
   * Called once on Queueway.start(). Persistent stores (SQLite, PostgreSQL)
   * should find any jobs left mid-flight by a previous run (crash/restart)
   * and return them so they get re-queued. Non-persistent stores
   * (InMemoryStore) should simply return [] — there's nothing to recover
   * since the store itself started empty this run.
   *
   * `options.includePending` is false when an external broker (Redis /
   * RabbitMQ) still holds pending jobs itself — re-publishing those would
   * run them twice. Shared stores must also avoid stealing jobs from other
   * workers that are still alive; see PostgreSQLStore.
   */
  recoverStuckJobs(options?: RecoverOptions): Promise<Job[]>;
  /** Permanently removes a job record — used for deleting jobs out of the DLQ. */
  deleteJob(jobId: string): Promise<void>;
  /** Real, live check — actually verifies the database connection is working right now. */
  checkHealth(): Promise<ComponentHealth>;
  /**
   * True when the store records which worker owns each in-flight job, so
   * recovery can distinguish "stranded by a crash" from "being worked on right
   * now". Only such stores can be polled for recovery while the app is
   * running; without ownership, polling would re-queue jobs that are simply
   * mid-retry. Absent means false.
   */
  readonly tracksJobOwnership?: boolean;

  /**
   * Releases database handles/connection pools. Optional: stores with
   * nothing to release simply don't implement it.
   */
  close?(): Promise<void>;
}
