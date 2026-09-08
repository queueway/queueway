import amqp from "amqplib";
import { IBroker } from "./IBroker";
import { Job } from "../types";
import { logger } from "../logging/Logger";
import { rabbitmqPrefetch, rabbitmqUrl } from "../config/env";

/** Where every Queueway message is published. Topic + durable. */
const EXCHANGE = "queueway";

/**
 * Where a rejected message goes instead of being deleted. Without a
 * dead-letter exchange, `nack(msg, false, false)` destroys the message
 * silently — see the note on nack() below.
 */
const DLX = "queueway.dlx";

/** Reconnect backoff: 1s, 2s, 4s … capped, with jitter. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Health must never hang on a dead socket — the dashboard's own fetch times
 * out and then reports everything as down. Same 2s bound the Postgres store
 * uses.
 */
const HEALTH_TIMEOUT_MS = 2_000;

/**
 * RabbitMQ broker.
 *
 * The reason to choose it over Redis is acknowledgement. Redis' BRPOP removes
 * a job the instant a worker takes it, so a worker dying mid-handler loses the
 * job from the broker and only the store's record brings it back. RabbitMQ
 * holds the message unacked and returns it to the queue by itself the moment
 * the connection drops — no store involvement, no waiting for a heartbeat to
 * go stale.
 *
 * That same property is why this broker sets `guaranteesRedelivery`: if the
 * store ALSO re-published those jobs, they would run twice.
 */
export class RabbitMQBroker implements IBroker {
  /** Jobs sit in a durable RabbitMQ queue, outside this process. */
  readonly retainsPendingJobs = true;

  /**
   * RabbitMQ returns an unacked in-flight message to the queue by itself.
   * Store-based recovery must therefore leave 'processing' jobs alone, or the
   * job runs twice — once from the broker's redelivery and once from ours.
   */
  readonly guaranteesRedelivery = true;

  /**
   * Deliveries are acknowledged, so a handler must not sit blocking inside the
   * consumer callback: the message stays unacked for the whole wait, holding
   * up everything behind it. Queueway schedules retry backoffs outside the
   * delivery when a broker declares this.
   */
  readonly acknowledgesDelivery = true;

  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.ConfirmChannel | null = null;

  /** Every live subscription, kept so a reconnect can rebuild all of them. */
  private subscriptions = new Map<string, (job: Job) => Promise<void>>();
  private consumerTags = new Map<string, string>();

  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private shuttingDown = false;

  /** One warning per outage, not one per retry — the Redis broker's rule. */
  private outageLogged = false;

  private get prefetchCount(): number {
    return rabbitmqPrefetch();
  }

  // ───────────────────────────────────────────────────────── connection

  async connect(): Promise<void> {
    this.shuttingDown = false;
    const url = rabbitmqUrl() || "amqp://localhost";

    this.connection = await amqp.connect(url);

    // An unhandled 'error' event ends the Node process. Listening is what turns
    // "RabbitMQ went away" from a crash into a logged blip.
    this.connection.on("error", (err: Error) => this.reportOutage("connection error", err));
    this.connection.on("close", () => {
      if (this.shuttingDown) return; // ordinary stop(), not a failure
      this.reportOutage("connection closed");
      this.channel = null;
      this.connection = null;
      this.scheduleReconnect();
    });

    await this.setupChannel();

    if (this.reconnectAttempt > 0) {
      logger.info(`✅ RabbitMQ reconnected after ${this.reconnectAttempt} attempt(s)`);
    } else {
      logger.info("✅ RabbitMQ connected");
    }
    this.reconnectAttempt = 0;
    this.outageLogged = false;
  }

  /**
   * Builds everything that lives on a channel — and rebuilds it after a
   * reconnect. The last step is the one that is easy to forget: without
   * replaying the subscriptions, the broker reports healthy and consumes
   * nothing.
   */
  private async setupChannel(): Promise<void> {
    if (!this.connection) throw new Error("RabbitMQ not connected");

    // A confirm channel is what makes publish() honest: plain
    // channel.publish() returns a boolean about its own write buffer and
    // reports success even when the broker never took the message.
    const channel = await this.connection.createConfirmChannel();
    this.channel = channel;

    channel.on("error", (err: Error) => this.reportOutage("channel error", err));
    channel.on("close", () => {
      if (this.shuttingDown || this.channel !== channel) return;
      // The channel can die on its own while the connection is still up (a 406,
      // or a failed passive check). Without this the broker would sit there
      // "connected" and never consume again, so tear the connection down and
      // let the reconnect path rebuild everything from scratch.
      this.channel = null;
      this.reportOutage("channel closed");
      void this.forceReconnect();
    });

    // Without prefetch, one consumer takes every available message and several
    // workers do not share the load at all.
    await channel.prefetch(this.prefetchCount);

    await channel.assertExchange(EXCHANGE, "topic", { durable: true });
    await channel.assertExchange(DLX, "topic", { durable: true });

    this.consumerTags.clear();
    for (const [eventName, handler] of this.subscriptions) {
      await this.bindQueue(eventName, handler);
    }
  }

  private async forceReconnect(): Promise<void> {
    const conn = this.connection;
    this.connection = null;
    try {
      await conn?.close();
    } catch {
      // Already gone. amqplib throws IllegalOperationError on a dead object;
      // that is not an error worth surfacing during recovery.
    }
    this.scheduleReconnect();
  }

  /**
   * amqplib never reconnects by itself. Without this, a five-second network
   * blip stops the worker consuming permanently — until someone restarts the
   * process.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.shuttingDown) return; // exactly one in flight

    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    // Jitter so a fleet of workers doesn't reconnect in lockstep and hammer a
    // broker that has only just come back.
    const delay = Math.round(base * (0.5 + Math.random() * 0.5));
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shuttingDown) return;
      this.connect().catch((err) => {
        this.reportOutage("reconnect failed", err);
        this.scheduleReconnect();
      });
    }, delay);

    // Must not keep a short-lived process alive on its own.
    this.reconnectTimer.unref?.();
  }

  private reportOutage(what: string, err?: any): void {
    if (this.outageLogged) return;
    this.outageLogged = true;
    logger.warn(`⚠️  RabbitMQ ${what} — reconnecting in the background`, {
      error: err?.message || err?.code || err?.name || "connection lost",
    });
  }

  // ───────────────────────────────────────────────────────── publishing

  async publish(eventName: string, job: Job): Promise<void> {
    const channel = this.channel;
    if (!channel) {
      throw new Error("RabbitMQ not connected. Call connect() first.");
    }

    await new Promise<void>((resolve, reject) => {
      const written = channel.publish(
        EXCHANGE,
        eventName,
        Buffer.from(JSON.stringify(job)),
        {
          persistent: true,
          messageId: job.id,
          contentType: "application/json",
        },
        // The broker's own ack/nack. This is the difference between "we handed
        // it to a socket" and "RabbitMQ has it on disk".
        (err) => (err ? reject(err) : resolve()),
      );

      // publish() returns false when amqplib's write buffer is full. The
      // confirm callback above still fires; this just avoids piling more on
      // until the socket drains.
      if (!written) channel.once("drain", () => undefined);
    });
  }

  // ───────────────────────────────────────────────────────── consuming

  subscribe(eventName: string, handler: (job: Job) => Promise<void>): void {
    // Kept regardless of connection state: this map is both the "subscribed
    // before connect()" buffer and the replay list for every future reconnect.
    this.subscriptions.set(eventName, handler);

    if (!this.channel) return; // connect() will bind it

    this.bindQueue(eventName, handler).catch((err) => {
      // The original code left this promise floating, so a failure here became
      // an unhandled rejection and the subscription silently never registered.
      logger.error(`❌ RabbitMQ could not subscribe to "${eventName}"`, {
        error: err?.message ?? String(err),
      });
    });
  }

  private async bindQueue(
    eventName: string,
    handler: (job: Job) => Promise<void>,
  ): Promise<void> {
    const channel = this.channel;
    if (!channel) throw new Error("RabbitMQ channel not initialised");

    const queueName = `queueway.${eventName}`;
    const deadQueueName = `queueway.dead.${eventName}`;

    // Somewhere for rejected messages to land. Without it, nack() deletes them.
    await channel.assertQueue(deadQueueName, { durable: true });
    await channel.bindQueue(deadQueueName, DLX, eventName);

    try {
      await channel.assertQueue(queueName, {
        durable: true,
        arguments: {
          "x-dead-letter-exchange": DLX,
          "x-dead-letter-routing-key": eventName,
        },
      });
    } catch (err: any) {
      // Declaring a queue with different arguments than the existing one fails
      // with 406 and kills the channel. Queues created before dead-lettering
      // was added hit this, and the raw error explains nothing.
      if (err?.code === 406) {
        throw new Error(
          `RabbitMQ queue "${queueName}" already exists with different settings — it was ` +
            `created by a Queueway version from before dead-lettering. Let it drain, then ` +
            `remove it with:  rabbitmqctl delete_queue ${queueName}`,
        );
      }
      throw err;
    }

    await channel.bindQueue(queueName, EXCHANGE, eventName);

    const { consumerTag } = await channel.consume(
      queueName,
      (msg: amqp.ConsumeMessage | null) => {
        if (!msg) return; // consumer cancelled by the broker
        void this.deliver(channel, msg, handler);
      },
      { noAck: false },
    );

    this.consumerTags.set(eventName, consumerTag);
  }

  private async deliver(
    channel: amqp.ConfirmChannel,
    msg: amqp.ConsumeMessage,
    handler: (job: Job) => Promise<void>,
  ): Promise<void> {
    let job: Job;
    try {
      job = JSON.parse(msg.content.toString());
    } catch (err: any) {
      // Unparseable content will never become parseable. Dead-letter it rather
      // than redelivering it forever.
      logger.error("❌ RabbitMQ message could not be parsed — dead-lettering it", {
        error: err?.message ?? String(err),
      });
      this.safeNack(channel, msg);
      return;
    }

    try {
      await handler(job);
      this.safeAck(channel, msg);
    } catch (err: any) {
      // Queueway's own wrapper handles retries and the DLQ, so reaching here
      // means the retry path itself failed — a store write during an outage,
      // typically. The dead-letter exchange is what keeps that message from
      // vanishing.
      logger.error(`❌ RabbitMQ handler failed outside the retry path — dead-lettering job ${job.id}`, {
        error: err?.message ?? String(err),
      });
      this.safeNack(channel, msg);
    }
  }

  /**
   * ack/nack throw if the channel died while the handler was running — which
   * is exactly when a handler takes a while. The message is already back in
   * the queue in that case, so there is nothing to do but not crash.
   */
  private safeAck(channel: amqp.ConfirmChannel, msg: amqp.ConsumeMessage): void {
    try {
      channel.ack(msg);
    } catch {
      /* channel gone; RabbitMQ has requeued the message */
    }
  }

  private safeNack(channel: amqp.ConfirmChannel, msg: amqp.ConsumeMessage): void {
    try {
      // requeue: false — with the DLX configured above this routes the message
      // to queueway.dead.<event> instead of deleting it, and avoids an endless
      // redelivery loop on a message that always fails.
      channel.nack(msg, false, false);
    } catch {
      /* channel gone; RabbitMQ has requeued the message */
    }
  }

  // ───────────────────────────────────────────────────────── lifecycle

  async disconnect(): Promise<void> {
    this.shuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    this.consumerTags.clear();

    try {
      await channel?.close();
    } catch {
      /* already closed */
    }
    try {
      await connection?.close();
    } catch {
      /* already closed */
    }
  }

  async checkHealth(): Promise<import("../types").ComponentHealth> {
    if (!this.connection || !this.channel) {
      return {
        status: "down",
        error: this.reconnectTimer ? "Reconnecting" : "Not connected",
      };
    }

    const start = Date.now();
    try {
      // Bounded: a stopped container's port proxy can keep accepting TCP, so an
      // unbounded check would hang instead of reporting "down".
      await this.withTimeout(this.channel.checkExchange(EXCHANGE), HEALTH_TIMEOUT_MS);
      return { status: "up", latency: Date.now() - start };
    } catch (err: any) {
      return { status: "down", error: err?.message ?? String(err) };
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}
