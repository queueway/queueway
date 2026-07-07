import { randomUUID } from 'crypto';
import { QueueKitConfig, Job } from './types';
import { IBroker } from './broker/IBroker';
import { InMemoryBroker } from './broker/InMemoryBroker';
import { RabbitMQBroker } from './broker/RabbitMQBroker';
import { IStore } from './store/IStore';
import { InMemoryStore } from './store/InMemoryStore';
import { PostgreSQLStore } from './store/PostgreSQLStore';
import { RetryManager } from './retry/RetryManager';
import { DLQManager } from './dlq/DLQManager';

export class QueueKit {
  private config: QueueKitConfig;
  private broker: IBroker;
  private store: IStore;
  private retryManager: RetryManager;
  private dlqManager: DLQManager;

  constructor(config?: Partial<QueueKitConfig>) {
    // Default production-safe config
    this.config = {
      broker: 'in-memory',
      store: 'in-memory',
      retry: {
        maxAttempts: 5,
        strategy: 'exponential',
      },
      ...config,
    };

    this.broker = this.createBroker(this.config.broker);
    this.store = this.createStore(this.config.store);
    this.retryManager = new RetryManager(
      this.config.retry?.maxAttempts,
      this.config.retry?.baseDelay,
      this.config.retry?.maxDelay
    );
    this.dlqManager = new DLQManager(this.store);
  }

  private createBroker(type: string): IBroker {
    switch (type) {
      case 'rabbitmq':
        return new RabbitMQBroker();
      case 'in-memory':
        return new InMemoryBroker();
      default:
        console.warn(`Broker "${type}" not yet wired up, falling back to in-memory`);
        return new InMemoryBroker();
    }
  }

  private createStore(type: string): IStore {
    switch (type) {
      case 'postgres':
        return new PostgreSQLStore();
      case 'in-memory':
        return new InMemoryStore();
      default:
        console.warn(`Store "${type}" not yet wired up, falling back to in-memory`);
        return new InMemoryStore();
    }
  }

  async publish(eventName: string, data: any): Promise<string> {
    const job: Job = {
      id: randomUUID(),
      eventName,
      data,
      status: 'pending',
      attempts: 0,
      createdAt: new Date(),
    };

    await this.store.saveJob(job);
    await this.broker.publish(eventName, job);
    return job.id;
  }

  subscribe(eventName: string, handler: (job: Job) => Promise<void>) {
    this.broker.subscribe(eventName, async (job) => {
      await this.store.updateJob(job.id, 'processing');
      try {
        await handler(job);
        await this.store.updateJob(job.id, 'completed');
      } catch (err) {
        job.attempts += 1;
        if (this.retryManager.shouldRetry(job)) {
          await this.store.updateJob(job.id, 'retrying');
          await this.retryManager.handleRetry(job);
        } else {
          await this.dlqManager.moveToDLQ(job);
        }
      }
    });
  }

  async start() {
    await this.store.initialize();
    await this.broker.connect();
    console.log('QueueKit started');
  }

  async stop() {
    await this.broker.disconnect();
  }

  /** Aggregate job counts by status — powers the /queuekit/stats API and dashboard. */
  async getStats() {
    const all = await this.store.getAllJobs();
    const counts = { pending: 0, processing: 0, completed: 0, failed: 0, retrying: 0, archived: 0 };
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
    return this.dlqManager.retryFromDLQ(jobId);
  }
}
