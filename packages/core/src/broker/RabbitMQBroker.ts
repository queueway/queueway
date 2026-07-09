import amqp from "amqplib";
import { IBroker } from "./IBroker";
import { Job } from "../types";
import { logger } from "../logging/Logger";

export class RabbitMQBroker implements IBroker {
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private readonly exchange = "queueway";
  private pendingSubscriptions: Array<{
    eventName: string;
    handler: (job: Job) => Promise<void>;
  }> = [];

  async connect(): Promise<void> {
    const url = process.env.RABBITMQ_URL || "amqp://localhost";
    this.connection = await amqp.connect(url);
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange(this.exchange, "topic", {
      durable: true,
    });
    logger.info("✅ RabbitMQ connected");

    // Replay any subscribe() calls made before connect() finished — this is
    // the normal pattern (subscribe() then start()), so it must work.
    const pending = this.pendingSubscriptions;
    this.pendingSubscriptions = [];
    for (const { eventName, handler } of pending) {
      this.bindQueue(eventName, handler);
    }
  }

  async publish(eventName: string, job: Job): Promise<void> {
    if (!this.channel)
      throw new Error("Channel not initialized. Call connect() first.");

    this.channel.publish(
      this.exchange,
      eventName,
      Buffer.from(JSON.stringify(job)),
      { persistent: true },
    );
  }

  subscribe(eventName: string, handler: (job: Job) => Promise<void>): void {
    if (!this.channel) {
      // Not connected yet — buffer it and register once connect() runs.
      this.pendingSubscriptions.push({ eventName, handler });
      return;
    }
    this.bindQueue(eventName, handler);
  }

  private bindQueue(eventName: string, handler: (job: Job) => Promise<void>): void {
    const queueName = `queueway.${eventName}`;
    this.channel!.assertQueue(queueName, { durable: true }).then(() => {
      this.channel!.bindQueue(queueName, this.exchange, eventName);
      this.channel!.consume(
        queueName,
        async (msg: amqp.ConsumeMessage | null) => {
          if (!msg) return;
          const job: Job = JSON.parse(msg.content.toString());
          try {
            await handler(job);
            this.channel!.ack(msg);
          } catch (err) {
            this.channel!.nack(msg, false, false);
          }
        },
      );
    });
  }

  async disconnect(): Promise<void> {
    if (this.connection) await this.connection.close();
  }

  async checkHealth(): Promise<import("../types").ComponentHealth> {
    if (!this.connection || !this.channel) {
      return { status: "down", error: "Not connected" };
    }
    try {
      const start = Date.now();
      await this.channel.checkExchange(this.exchange);
      return { status: "up", latency: Date.now() - start };
    } catch (err: any) {
      return { status: "down", error: err?.message ?? String(err) };
    }
  }
}
