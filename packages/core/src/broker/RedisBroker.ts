import Redis from "ioredis";
import { IBroker } from "./IBroker";
import { Job } from "../types";
import { logger } from "../logging/Logger";
import { redisUrl } from "../config/env";

/** Connection-level failures, as opposed to a genuine bug in a handler. */
function isConnectionError(err: any): boolean {
  const text = `${err?.name ?? ""} ${err?.code ?? ""} ${err?.message ?? ""}`;
  return /MaxRetriesPerRequest|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|Connection is closed|Stream isn't writeable/i.test(
    text,
  );
}

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
    return redisUrl() || "redis://localhost:6379";
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
    // ioredis retries on a timer, so a five-minute outage would otherwise
    // produce hundreds of identical lines. Report the outage once, then stay
    // quiet until the connection is actually back.
    let reported = false;

    client.on("error", (err: any) => {
      if (reported) return;
      reported = true;
      logger.warn(`⚠️  Redis ${role} unreachable — reconnecting in the background`, {
        // Some socket errors arrive with an empty message (common on Windows),
        // so fall back to whatever identifying detail the error does carry.
        error: err?.message || err?.code || err?.syscall || err?.name || "connection lost",
      });
    });

    client.on("ready", () => {
      if (reported) {
        logger.info(`✅ Redis ${role} reconnected`);
        reported = false;
      }
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
      // Tracks consecutive connection failures so an outage produces one
      // warning and a backoff, rather than a stack trace every few
      // milliseconds for as long as Redis is away.
      let outageLogged = false;

      while (this.polling) {
        try {
          // Blocks for up to 5s waiting for a job; returns null on timeout.
          const result = await client.brpop(queueKey, 5);

          if (outageLogged) {
            logger.info(`✅ Redis reachable again — resumed consuming "${eventName}"`);
            outageLogged = false;
          }

          if (!result) continue;

          const [, raw] = result;
          const job: Job = JSON.parse(raw);
          await handler(job);
        } catch (err: any) {
          if (!this.polling) break;

          if (isConnectionError(err)) {
            // Redis being down is an operational condition, not a bug. ioredis
            // keeps trying to reconnect underneath; without a pause here the
            // loop would spin at full speed for the whole outage.
            if (!outageLogged) {
              logger.warn(
                `⚠️  Redis unreachable — paused consuming "${eventName}", will resume automatically`,
                { error: err?.message ?? String(err) },
              );
              outageLogged = true;
            }
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }

          logger.error(`RedisBroker error on "${eventName}"`, {
            error: err?.message ?? String(err),
            stack: err?.stack,
          });
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
