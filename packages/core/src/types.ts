export type BrokerType = "in-memory" | "rabbitmq" | "redis";
export type StoreType = "in-memory" | "sqlite" | "postgres";

export interface ComponentHealth {
  status: "up" | "down";
  latency?: number;
  error?: string;
  /**
   * Which implementation is actually in use ("redis", "sqlite", …). Shown on
   * the dashboard: "up" alone doesn't tell an operator whether they're looking
   * at the in-memory broker or a real Redis, and that difference decides
   * whether their jobs survive a restart.
   */
  type?: string;
}

export interface QueuewayConfig {
  broker: BrokerType;
  store: StoreType;
  retry?: {
    maxAttempts: number;
    strategy: string;
    baseDelay?: number;
    maxDelay?: number;
  };
}

export type JobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "retrying"
  | "archived";

export interface Job {
  id: string;
  eventName: string;
  data: any;
  status: JobStatus;
  attempts: number;
  createdAt: Date;
}

/** Controls how `IStore.recoverStuckJobs()` decides what is actually stuck. */
export interface RecoverOptions {
  /**
   * Whether 'pending' jobs count as lost. True for brokers that hold the
   * queue in this process (in-memory) — when the process dies, so does the
   * queue. False for external brokers (Redis/RabbitMQ), which still hold
   * the job themselves; re-publishing it would deliver it twice.
   */
  includePending?: boolean;
  /**
   * How long a worker can go without a heartbeat before it's presumed dead
   * and its in-flight jobs may be taken over by someone else.
   */
  staleAfterMs?: number;
}
