import { Job, ComponentHealth } from '../types';

export interface IBroker {
  /**
   * True when the broker itself holds pending jobs outside this process
   * (Redis, RabbitMQ). Recovery must NOT re-publish 'pending' jobs for these
   * — the broker still has them, so re-publishing delivers them twice.
   * False for the in-memory broker, whose queue dies with the process.
   */
  readonly retainsPendingJobs: boolean;

  /**
   * True when the broker returns an in-flight ('processing') job to the queue
   * by itself once the worker holding it disappears — RabbitMQ, because
   * deliveries are acknowledged. Store-based recovery must then leave those
   * jobs alone: the broker is already redelivering, so re-publishing would run
   * the job a second time.
   *
   * False (or absent) for Redis and the in-memory broker, where BRPOP/the
   * process queue removes the job on delivery and only the store's record can
   * bring it back. Absent means false.
   */
  readonly guaranteesRedelivery?: boolean;

  /**
   * True when a delivery is held open until the handler acknowledges it, so
   * blocking inside the handler blocks the queue behind it. Queueway waits out
   * a retry backoff outside the delivery for such brokers, instead of sleeping
   * mid-handler. Absent means false — the existing behaviour, unchanged.
   */
  readonly acknowledgesDelivery?: boolean;

  publish(eventName: string, job: Job): Promise<void>;
  subscribe(eventName: string, handler: (job: Job) => Promise<void>): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Real, live check — actually verifies the broker connection is working right now. */
  checkHealth(): Promise<ComponentHealth>;
}
