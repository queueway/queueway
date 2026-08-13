import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { QueuewayConfig, Job } from "./types";
import { IBroker } from "./broker/IBroker";
import { InMemoryBroker } from "./broker/InMemoryBroker";
import { RabbitMQBroker } from "./broker/RabbitMQBroker";
import { RedisBroker } from "./broker/RedisBroker";
import { IStore } from "./store/IStore";
import { InMemoryStore } from "./store/InMemoryStore";
import { PostgreSQLStore } from "./store/PostgreSQLStore";
import { SQLiteStore } from "./store/SQLiteStore";
import { RetryManager } from "./retry/RetryManager";
import { DLQManager } from "./dlq/DLQManager";
import { HealthCheck } from "./monitoring/HealthCheck";
import { logger } from "./logging/Logger";

/** How often to look for work stranded by an outage. */
const RECOVERY_INTERVAL_MS = 30_000;

export class Queueway {
  private config: QueuewayConfig;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private broker: IBroker;
  private store: IStore;
  private retryManager: RetryManager;
  private dlqManager: DLQManager;
  private healthCheck: HealthCheck;

  constructor(config?: Partial<QueuewayConfig>) {
    // Default production-safe config
    this.config = {
      broker: "in-memory",
      store: "in-memory",
      retry: {
        maxAttempts: 5,
        strategy: "exponential",
      },
      ...config,
    };

    this.broker = this.createBroker(this.config.broker);
    this.store = this.createStore(this.config.store);
    this.retryManager = new RetryManager(
      this.config.retry?.maxAttempts,
      this.config.retry?.baseDelay,
      this.config.retry?.maxDelay,
    );
    this.dlqManager = new DLQManager(this.store);
    this.healthCheck = new HealthCheck(this.broker, this.store);
  }

  private createBroker(type: string): IBroker {
    switch (type) {
      case "rabbitmq":
        return new RabbitMQBroker();
      case "redis":
        return new RedisBroker();
      case "in-memory":
        return new InMemoryBroker();
      default:
        logger.warn(
          `Broker "${type}" not yet wired up, falling back to in-memory`,
        );
        return new InMemoryBroker();
    }
  }

  private createStore(type: string): IStore {
    switch (type) {
      case "postgres":
        return new PostgreSQLStore();
      case "sqlite":
        return new SQLiteStore();
      case "in-memory":
        return new InMemoryStore();
      default:
        logger.warn(
          `Store "${type}" not yet wired up, falling back to in-memory`,
        );
        return new InMemoryStore();
    }
  }

  async publish(eventName: string, data: any): Promise<string> {
    const job: Job = {
      id: randomUUID(),
      eventName,
      data,
      status: "pending",
      attempts: 0,
      createdAt: new Date(),
    };

    await this.store.saveJob(job);
    await this.broker.publish(eventName, job);
    return job.id;
  }

  subscribe(eventName: string, handler: (job: Job) => Promise<void>) {
    this.broker.subscribe(eventName, async (job) => {
      await this.store.updateJob(job.id, "processing", job.attempts);
      try {
        await handler(job);
        await this.store.updateJob(job.id, "completed", job.attempts);
      } catch (err) {
        job.attempts += 1;
        if (this.retryManager.shouldRetry(job)) {
          await this.store.updateJob(job.id, "retrying", job.attempts);
          await this.retryManager.handleRetry(job); // waits for the backoff delay
          await this.store.updateJob(job.id, "pending", job.attempts);
          await this.broker.publish(eventName, job); // actually re-queue the job
        } else {
          await this.dlqManager.moveToDLQ(job);
        }
      }
    });
  }

  /**
   * Boots the engine: connects the store/broker, recovers any stuck jobs,
   * and auto-loads `queueway.jobs.js` from your project root if present
   * (so subscribe() handlers work even without going through the CLI).
   *
   * Pass `{ withServer: true }` to also start the REST API + dashboard on
   * the given port (default 4287) — everything `queueway start` does,
   * minus background mode and auto-heal, which need an external process
   * to supervise this one (a crashed process can't restart itself; that's
   * exactly what `queueway start`'s watchdog — or PM2/systemd/Docker for
   * your own app — is for).
   */
  async start(options: { withServer?: boolean; port?: number } = {}) {
    await this.store.initialize();
    await this.broker.connect();

    this.loadJobsFile();

    // Generic across all stores: in-memory returns [], persistent stores
    // (SQLite/Postgres) return anything left mid-flight from a previous
    // crash/restart so it gets re-queued instead of silently lost.
    //
    // `includePending` is the difference between brokers: the in-memory
    // broker loses its queue when the process dies, so a 'pending' job is
    // genuinely gone and must be re-published. Redis/RabbitMQ still hold it
    // themselves — re-publishing there would run the job twice.
    const recovered = await this.store.recoverStuckJobs({
      includePending: !this.broker.retainsPendingJobs,
    });
    for (const job of recovered) {
      await this.broker.publish(job.eventName, job);
    }
    if (recovered.length > 0) {
      logger.info(
        `♻️  Recovered ${recovered.length} stuck job(s) from a previous run`,
      );
    }

    this.startRecoveryWatcher();

    logger.info("Queueway started");

    if (options.withServer) {
      const { startServer } = await import("./server/createServer");
      await startServer(this, options.port ?? 4287);
    }
  }

  /**
   * Loads job handlers with the same freedom you'd have embedding Queueway
   * directly in your own app — you're not boxed into one file:
   *   1. queueway.jobs.js/.cjs — a single entry point (can itself require()
   *      as many other files as you want; it's just where loading starts)
   *   2. jobs/ directory — every .js/.cjs file inside is auto-loaded, so you
   *      can freely split handlers across as many files as you like with no
   *      manual wiring at all (jobs/email.js, jobs/payments.js, etc.)
   * Both are optional and can be used together.
   */
  private loadJobsFile(): void {
    this.loadJobsEntryFile();
    this.loadJobsDirectory();
  }

  private registerFromModule(modulePath: string, label: string): void {
    const registerJobs = require(modulePath);
    const register = typeof registerJobs === "function" ? registerJobs : registerJobs?.default;
    if (typeof register === "function") {
      register(this);
      logger.info(`✅ Loaded job handlers from ${label}`);
    } else {
      logger.warn(`⚠️  ${label} was found but doesn't export a function — no handlers registered.`);
    }
  }

  private loadJobsEntryFile(): void {
    try {
      const candidates = ["queueway.jobs.js", "queueway.jobs.cjs"];
      const jobsPath = candidates
        .map((name) => path.resolve(process.cwd(), name))
        .find((p) => fs.existsSync(p));
      if (!jobsPath) return;
      this.registerFromModule(jobsPath, path.basename(jobsPath));
    } catch (err: any) {
      logger.warn("⚠️  Found queueway.jobs.js but failed to load it", { error: String(err) });
    }
  }

  private loadJobsDirectory(): void {
    try {
      const dir = path.resolve(process.cwd(), "jobs");
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;

      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".js") || f.endsWith(".cjs"))
        .sort();

      for (const file of files) {
        try {
          this.registerFromModule(path.join(dir, file), `jobs/${file}`);
        } catch (err: any) {
          logger.warn(`⚠️  Found jobs/${file} but failed to load it`, { error: String(err) });
        }
      }
    } catch (err: any) {
      logger.warn("⚠️  Failed to read jobs/ directory", { error: String(err) });
    }
  }

  /**
   * Periodically re-runs recovery so an outage heals itself.
   *
   * Docker restarts the containers (`restart: unless-stopped`) and the drivers
   * reconnect, but jobs that were mid-flight when the service vanished stay
   * marked 'processing' in the store — they'd sit there until the app itself
   * was restarted. This picks them up instead, so a database or broker going
   * down and coming back needs no intervention at all.
   *
   * Recovery is already worker-aware, so this is safe with several workers
   * running: it only reclaims jobs whose owner has stopped heartbeating.
   */
  private startRecoveryWatcher(): void {
    if (this.recoveryTimer) return;

    // Only safe where the store knows who owns each job. SQLite is a single
    // local process anyway — it has no service that can go down independently,
    // so there is nothing for a watcher to heal there.
    if (!this.store.tracksJobOwnership) return;

    this.recoveryTimer = setInterval(async () => {
      try {
        const recovered = await this.store.recoverStuckJobs({
          includePending: !this.broker.retainsPendingJobs,
        });
        for (const job of recovered) {
          await this.broker.publish(job.eventName, job);
        }
        if (recovered.length > 0) {
          logger.info(`♻️  Re-queued ${recovered.length} job(s) after a service outage`);
        }
      } catch {
        // The store is still unreachable — nothing to do but try again later.
      }
    }, RECOVERY_INTERVAL_MS);

    // Must not keep a short-lived process alive on its own.
    this.recoveryTimer.unref?.();
  }

  async stop() {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    await this.broker.disconnect();
    // Release DB handles too. Postgres pools in particular stay open for the
    // life of the process otherwise, which exhausts the connection limits on
    // managed providers' smaller plans. Stores with nothing to release don't
    // implement close().
    await this.store.close?.();
  }

  /** Aggregate job counts by status — powers the /queueway/stats API and dashboard. */
  async getStats() {
    const all = await this.store.getAllJobs();
    const counts = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      retrying: 0,
      archived: 0,
    };
    for (const job of all) {
      counts[job.status] = (counts[job.status] ?? 0) + 1;
    }
    return { jobs: counts, total: all.length };
  }

  async getJob(jobId: string) {
    return this.store.getJob(jobId);
  }

  async getJobs(status?: string, limit?: number) {
    return this.store.getAllJobs(status, limit);
  }

  async getDLQ(limit?: number) {
    return this.dlqManager.getFailedJobs(limit);
  }

  async retryJob(jobId: string) {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    await this.dlqManager.retryFromDLQ(jobId);
    job.status = "pending";
    job.attempts = 0;
    await this.broker.publish(job.eventName, job);
  }

  /** Permanently removes a job record — e.g. deleting a job out of the DLQ you don't want to retry. */
  async deleteJob(jobId: string) {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    await this.store.deleteJob(jobId);
  }

  /** Real health check — actually pings the broker + database right now. */
  async getHealth() {
    return this.healthCheck.getStatus();
  }
}
