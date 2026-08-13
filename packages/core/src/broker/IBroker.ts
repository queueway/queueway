import { Job, ComponentHealth } from '../types';

export interface IBroker {
  /**
   * True when the broker itself holds pending jobs outside this process
   * (Redis, RabbitMQ). Recovery must NOT re-publish 'pending' jobs for these
   * — the broker still has them, so re-publishing delivers them twice.
   * False for the in-memory broker, whose queue dies with the process.
   */
  readonly retainsPendingJobs: boolean;
  publish(eventName: string, job: Job): Promise<void>;
  subscribe(eventName: string, handler: (job: Job) => Promise<void>): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Real, live check — actually verifies the broker connection is working right now. */
  checkHealth(): Promise<ComponentHealth>;
}
