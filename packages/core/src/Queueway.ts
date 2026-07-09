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

export class Queueway {
  private config: QueuewayConfig;
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

  async start() {
    await this.store.initialize();
    await this.broker.connect();

    // Generic across all stores: in-memory returns [], persistent stores
    // (SQLite/Postgres) return anything left mid-flight from a previous
    // crash/restart so it gets re-queued instead of silently lost.
    const recovered = await this.store.recoverStuckJobs();
    for (const job of recovered) {
      await this.broker.publish(job.eventName, job);
    }
    if (recovered.length > 0) {
      logger.info(
        `♻️  Recovered ${recovered.length} stuck job(s) from a previous run`,
      );
    }

    logger.info("Queueway started");
  }

  async stop() {
    await this.broker.disconnect();
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

  /** Real health check — actually pings the broker + database right now. */
  async getHealth() {
    return this.healthCheck.getStatus();
  }
}
