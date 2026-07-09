import { IBroker } from "./IBroker";
import { Job, ComponentHealth } from "../types";
import { logger } from "../logging/Logger";

export class InMemoryBroker implements IBroker {
  private handlers: Map<string, Array<(job: Job) => Promise<void>>> = new Map();

  async connect(): Promise<void> {
    logger.info("✅ In-Memory broker ready");
  }

  async publish(eventName: string, job: Job): Promise<void> {
    const handlers = this.handlers.get(eventName) || [];
    for (const handler of handlers) {
      await handler(job);
    }
  }

  subscribe(eventName: string, handler: (job: Job) => Promise<void>): void {
    if (!this.handlers.has(eventName)) {
      this.handlers.set(eventName, []);
    }
    this.handlers.get(eventName)!.push(handler);
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async checkHealth(): Promise<ComponentHealth> {
    // Nothing external to check — if this process is running, it's up.
    return { status: "up" };
  }
}
