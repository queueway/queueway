import { Pool } from "pg";
import { randomUUID } from "crypto";
import { IStore } from "./IStore";
import { Job, RecoverOptions } from "../types";
import { logger } from "../logging/Logger";
import { databaseUrl } from "../config/env";

/** How often this worker says "I'm still alive". */
const HEARTBEAT_INTERVAL_MS = 10_000;
/** No heartbeat for this long ⇒ the worker is presumed dead. */
const DEFAULT_STALE_AFTER_MS = 30_000;

/**
 * PostgreSQL store — the only store that can be shared by several workers
 * at once (SQLite is a local file; two servers can't write to it).
 *
 * Because it's shared, recovery can't just grab every unfinished row: a row
 * in 'processing' might belong to another worker that is alive and busy
 * right now. Re-queuing it would run the job twice — two invoices, two
 * emails. So each worker registers itself in `queueway_workers` and
 * heartbeats; recovery only reclaims jobs whose owner has stopped
 * heartbeating. When no other worker is alive, it reclaims everything
 * immediately, which is the ordinary single-server restart.
 */
export class PostgreSQLStore implements IStore {
  /** Ownership is tracked via worker_id + heartbeats, so periodic recovery is safe. */
  readonly tracksJobOwnership = true;
  private pool: Pool;
  private readonly workerId = randomUUID();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor() {
    const url = databaseUrl() || "postgres://localhost/queueway";
    this.pool = new Pool({
      connectionString: url,
      // Without these, a database that accepts TCP but never answers — exactly
      // what a stopped Docker container looks like, because Docker's port proxy
      // keeps listening — leaves every query waiting indefinitely. Health would
      // report 'up' simply because the check never came back.
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      query_timeout: 10000,
    });

    // Without this listener, a database that goes away (container stopped,
    // network blip, failover) makes node-postgres emit an 'error' on an idle
    // client — and an unhandled 'error' event takes the whole process down.
    // The pool opens fresh connections on the next query, so surviving the
    // event is all that's needed to reconnect automatically.
    this.pool.on("error", (err: Error) => {
      logger.warn("⚠️  PostgreSQL connection dropped — will reconnect on the next query", {
        error: err.message,
      });
    });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS queueway_jobs (
        id VARCHAR(255) PRIMARY KEY,
        event_name VARCHAR(255) NOT NULL,
        data JSONB NOT NULL,
        status VARCHAR(50) NOT NULL,
        attempts INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Added after 0.0.2; IF NOT EXISTS keeps existing installs upgradable.
      ALTER TABLE queueway_jobs ADD COLUMN IF NOT EXISTS worker_id VARCHAR(64);
      ALTER TABLE queueway_jobs ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP;

      CREATE INDEX IF NOT EXISTS idx_status ON queueway_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_event ON queueway_jobs(event_name);
      CREATE INDEX IF NOT EXISTS idx_worker ON queueway_jobs(worker_id);

      CREATE TABLE IF NOT EXISTS queueway_workers (
        id VARCHAR(64) PRIMARY KEY,
        started_at TIMESTAMP DEFAULT NOW(),
        last_seen TIMESTAMP DEFAULT NOW()
      );
    `);

    await this.registerWorker();
    this.startHeartbeat();

    logger.info("✅ PostgreSQL initialized");
  }

  // ---------------------------------------------------------------- worker

  private async registerWorker(): Promise<void> {
    await this.pool.query(
      `INSERT INTO queueway_workers (id, started_at, last_seen)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET last_seen = NOW()`,
      [this.workerId],
    );
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.beat().catch((err) =>
        logger.warn("⚠️  Worker heartbeat skipped — database unreachable", {
          error: err?.message || err?.errors?.[0]?.message || err?.code || String(err),
        }),
      );
    }, HEARTBEAT_INTERVAL_MS);
    // Don't hold the event loop open just for the heartbeat — a short script
    // that finishes its work should still be able to exit on its own.
    this.heartbeatTimer.unref?.();
  }

  private async beat(): Promise<void> {
    await this.pool.query(
      `UPDATE queueway_workers SET last_seen = NOW() WHERE id = $1`,
      [this.workerId],
    );
    // Refresh the lock on everything this worker currently holds, so a long
    // job (or a long retry backoff) is never mistaken for a dead worker's.
    await this.pool.query(
      `UPDATE queueway_jobs SET locked_at = NOW()
       WHERE worker_id = $1 AND status IN ('processing', 'retrying')`,
      [this.workerId],
    );
  }

  // ------------------------------------------------------------------ jobs

  async saveJob(job: Job): Promise<void> {
    await this.pool.query(
      `INSERT INTO queueway_jobs (id, event_name, data, status, attempts)
       VALUES ($1, $2, $3, $4, $5)`,
      [job.id, job.eventName, JSON.stringify(job.data), job.status, job.attempts],
    );
  }

  async getJob(jobId: string): Promise<Job | null> {
    const result = await this.pool.query(
      "SELECT * FROM queueway_jobs WHERE id = $1",
      [jobId],
    );
    if (result.rows.length === 0) return null;
    return this.rowToJob(result.rows[0]);
  }

  async updateJob(
    jobId: string,
    status: string,
    attempts?: number,
  ): Promise<void> {
    // A job in flight is owned by this worker and its lock kept fresh; once
    // it's finished (or dead) the ownership is released so nothing else
    // treats it as recoverable.
    const inFlight = status === "processing" || status === "retrying";
    const owner = inFlight ? this.workerId : null;

    if (attempts !== undefined) {
      await this.pool.query(
        `UPDATE queueway_jobs
         SET status = $1, attempts = $2, worker_id = $3::text,
             locked_at = CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() END,
             updated_at = NOW()
         WHERE id = $4`,
        [status, attempts, owner, jobId],
      );
    } else {
      await this.pool.query(
        `UPDATE queueway_jobs
         SET status = $1, worker_id = $2::text,
             locked_at = CASE WHEN $2::text IS NULL THEN NULL ELSE NOW() END,
             updated_at = NOW()
         WHERE id = $3`,
        [status, owner, jobId],
      );
    }
  }

  async getAllJobs(status?: string, limit?: number): Promise<Job[]> {
    let query = "SELECT * FROM queueway_jobs";
    const params: any[] = [];

    if (status) {
      query += " WHERE status = $1";
      params.push(status);
    }

    query += " ORDER BY created_at DESC";

    if (limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(limit);
    }

    const result = await this.pool.query(query, params);
    return result.rows.map((row: any) => this.rowToJob(row));
  }

  private rowToJob(row: any): Job {
    return {
      id: row.id,
      eventName: row.event_name,
      data: row.data,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at,
    };
  }

  // -------------------------------------------------------------- recovery

  async recoverStuckJobs(options: RecoverOptions = {}): Promise<Job[]> {
    const includePending = options.includePending ?? true;
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const staleSeconds = Math.ceil(staleAfterMs / 1000);

    // 1. Forget workers that stopped heartbeating — they crashed or exited.
    await this.pool.query(
      `DELETE FROM queueway_workers
       WHERE last_seen < NOW() - ($1 || ' seconds')::interval`,
      [String(staleSeconds)],
    );

    // 2. Is anyone else actually alive right now?
    const others = await this.pool.query(
      `SELECT count(*)::int AS n FROM queueway_workers WHERE id <> $1`,
      [this.workerId],
    );
    const aloneOnTheStore = others.rows[0].n === 0;

    // 3. Decide what counts as stuck.
    //    'processing' is excluded only for brokers that redeliver an unacked
    //    message themselves (RabbitMQ) — taking it here as well would hand the
    //    same job to two workers.
    const statuses =
      options.includeProcessing === false ? ["retrying"] : ["processing", "retrying"];
    const params: any[] = [statuses];
    let where: string;

    if (aloneOnTheStore) {
      // Ordinary single-server restart: nothing else is running, so everything
      // unfinished is ours to recover — except whatever THIS worker is holding
      // at this moment. On a fresh start() that's nothing; while running, it's
      // the jobs currently being processed or waiting out a retry backoff, and
      // re-queuing those would run them twice.
      if (includePending) statuses.push("pending");
      where = `status = ANY($1::text[])
               AND (worker_id IS NULL OR worker_id <> $2::text)`;
      params.push(this.workerId);
    } else {
      // Other workers are live. Only take jobs whose owner is gone — never
      // 'pending' (that job is sitting in someone's queue, not lost), and
      // never a job still being heartbeated by a healthy worker.
      where = `status = ANY($1::text[])
               AND (worker_id IS NULL
                    OR worker_id NOT IN (SELECT id FROM queueway_workers))
               AND (worker_id IS NULL OR worker_id <> $2::text)`;
      params.push(this.workerId);
    }

    // 4. Claim them atomically. SKIP LOCKED means two workers recovering at
    //    the same instant can never hand out the same job twice.
    const result = await this.pool.query(
      `UPDATE queueway_jobs
       SET status = 'pending', worker_id = NULL, locked_at = NULL, updated_at = NOW()
       WHERE id IN (
         SELECT id FROM queueway_jobs WHERE ${where} FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      params,
    );

    return result.rows.map((row: any) => ({
      ...this.rowToJob(row),
      status: "pending" as const,
    }));
  }

  // ------------------------------------------------------------------ misc

  async deleteJob(jobId: string): Promise<void> {
    await this.pool.query(`DELETE FROM queueway_jobs WHERE id = $1`, [jobId]);
  }

  async checkHealth(): Promise<import("../types").ComponentHealth> {
    const start = Date.now();
    try {
      // Bounded independently of the pool's own timeouts: a health check that
      // hangs is worse than one that fails, because the dashboard then shows
      // stale "up" instead of the truth.
      await Promise.race([
        this.pool.query("SELECT 1"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Database did not respond within 2s")), 2000),
        ),
      ]);
      return { status: "up", latency: Date.now() - start };
    } catch (err: any) {
      return { status: "down", error: err?.message ?? String(err) };
    }
  }

  /**
   * Stops the heartbeat, deregisters this worker and closes the connection
   * pool. Without this, connections stay open until the process dies — which
   * quietly exhausts the connection limits managed Postgres providers put on
   * their smaller plans.
   */
  async close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      // Leaving cleanly: release anything still held so the next worker can
      // pick it up straight away instead of waiting out the stale timeout.
      await this.pool.query(
        `UPDATE queueway_jobs SET worker_id = NULL, locked_at = NULL
         WHERE worker_id = $1 AND status IN ('processing', 'retrying')`,
        [this.workerId],
      );
      await this.pool.query(`DELETE FROM queueway_workers WHERE id = $1`, [
        this.workerId,
      ]);
    } catch {
      // Shutting down anyway — a failure here must not block process exit.
    }
    await this.pool.end();
  }
}
