import { Job, ComponentHealth } from '../types';

export interface IBroker {
  publish(eventName: string, job: Job): Promise<void>;
  subscribe(eventName: string, handler: (job: Job) => Promise<void>): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Real, live check — actually verifies the broker connection is working right now. */
  checkHealth(): Promise<ComponentHealth>;
}
