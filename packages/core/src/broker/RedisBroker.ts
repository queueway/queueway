import Redis from 'ioredis';
import { IBroker } from './IBroker';
import { Job } from '../types';

/**
 * Redis-backed broker using Lists (LPUSH/BRPOP) — a lightweight
 * alternative to RabbitMQ. Good for simpler setups that already
 * have Redis running for caching/sessions.
 */
export class RedisBroker implements IBroker {
  private publisherClient: Redis | null = null;
  private subscriberClients: Redis[] = [];
  private polling = true;
  private readonly prefix = 'queueway:queue:';

  private getUrl(): string {
    return process.env.REDIS_URL || 'redis://localhost:6379';
  }

  async connect(): Promise<void> {
    this.publisherClient = new Redis(this.getUrl());
    console.log('✅ Redis connected');
  }

  async publish(eventName: string, job: Job): Promise<void> {
    if (!this.publisherClient) {
      throw new Error('Redis not connected. Call connect() first.');
    }
    await this.publisherClient.lpush(this.prefix + eventName, JSON.stringify(job));
  }

  subscribe(eventName: string, handler: (job: Job) => Promise<void>): void {
    const client = new Redis(this.getUrl());
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
        } catch (err) {
          if (!this.polling) break;
          console.error(`RedisBroker error on "${eventName}":`, err);
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
}
