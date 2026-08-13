import Redis from "ioredis";
import { IBroker } from "./IBroker";
import { Job } from "../types";
import { logger } from "../logging/Logger";

/**
 * Redis-backed broker using Lists (LPUSH/BRPOP) — a lightweight
 * alternative to RabbitMQ. Good for simpler setups that already
 * have Redis running for caching/sessions.
 */
export class RedisBroker implements IBroker {
  /** Jobs sit in a Redis list, outside this process. */
  readonly retainsPendingJobs = true;
  private publisherClient: Redis | null = null;
  private subscriberClients: Redis[] = [];
  private polling = true;
  private readonly prefix = "queueway:queue:";

  private getUrl(): string {
    return process.env.REDIS_URL || "redis://localhost:6379";
  }

  /**
   * ioredis defaults to retrying a command 20 times before failing, which
   * turns "Redis is down" into a ten-second hang for the caller. Three is
   * enough to ride out a blip while still failing fast enough that a health
   * check or a publish() returns promptly. Reconnection itself is unaffected —
   * ioredis keeps trying in the background either way.
   */
  private clientOptions() {
    return { maxRetriesPerRequest: 3, connectTimeout: 5000 };
  }

  /**
   * ioredis reconnects on its own, but it also emits 'error' while doing so —
   * and an unhandled 'error' event ends the process. Attaching a listener is
   * what turns "Redis went away" from a crash into a logged blip.
   */
  private attachErrorHandler(client: Redis, role: string): Redis {
    client.on("error", (err: Error) => {
      logger.warn(`⚠️  Redis ${role} connection problem — retrying`, {
        error: err.message,
      });
    });
    return client;
  }

  async connect(): Promise<void> {
    this.publisherClient = this.attachErrorHandler(new Redis(this.getUrl(), this.clientOptions()), "publisher");
    logger.info("✅ Redis connected");
  }

  async publish(eventName: string, job: Job): Promise<void> {
    if (!this.publisherClient) {
      throw new Error("Redis not connected. Call connect() first.");
    }
    await this.publisherClient.lpush(
      this.prefix + eventName,
      JSON.stringify(job),
    );
  }

  subscribe(eventName: string, handler: (job: Job) => Promise<void>): void {
    const client = this.attachErrorHandler(new Redis(this.getUrl(), this.clientOptions()), "subscriber");
    this.subscriberClients.push(client);
    const queueKey = this.prefix + eventName;

    const poll = async () => {
      while (this.polling) {
        try {
          // Blocks for up to 5s waiting for a job; returns null on timeout.
          const result = await client.brpop(queueKey, 5);
          if (!result) continue;

          const [, raw] = result;
          const job: Job = JSON.parse(raw);
          await handler(job);
        } catch (err: any) {
          if (!this.polling) break;
          logger.error(`RedisBroker error on "${eventName}"`, { error: err?.message ?? String(err), stack: err?.stack });
        }
      }
    };

    poll();
  }

  async disconnect(): Promise<void> {
    this.polling = false;
    if (this.publisherClient) await this.publisherClient.quit();
    for (const client of this.subscriberClients) {
      await client.quit();
    }
  }

  async checkHealth(): Promise<import("../types").ComponentHealth> {
    if (!this.publisherClient) {
      return { status: "down", error: "Not connected" };
    }
    try {
      const start = Date.now();
      await this.publisherClient.ping();
      return { status: "up", latency: Date.now() - start };
    } catch (err: any) {
      return { status: "down", error: err?.message ?? String(err) };
    }
  }
}
