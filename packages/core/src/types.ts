export interface QueuewayConfig {
  broker: string;
  store: string;
  retry?: {
    maxAttempts: number;
    strategy: string;
    baseDelay?: number;
    maxDelay?: number;
  };
}

export type JobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'archived';

export interface Job {
  id: string;
  eventName: string;
  data: any;
  status: JobStatus;
  attempts: number;
  createdAt: Date;
}
