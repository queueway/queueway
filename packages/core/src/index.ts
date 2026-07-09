// Auto-load .env from the project root — must run before anything below
// reads process.env (SMTP config, ports, dashboard auth, etc).
import dotenv from "dotenv";
dotenv.config();

export { Queueway } from "./Queueway";
export type { QueuewayConfig, Job, JobStatus } from "./types";
export { Logger, logger } from './logging/Logger';
export type { LogLevel } from './logging/Logger';

/** Identity helper for type-safe config files (queueway.config.ts) — mirrors the pattern used by Vite/Next/etc. */
export function defineConfig(
  config: import("./types").QueuewayConfig,
): import("./types").QueuewayConfig {
  return config;
}

export { InMemoryBroker } from "./broker/InMemoryBroker";
export { RabbitMQBroker } from "./broker/RabbitMQBroker";
export { RedisBroker } from "./broker/RedisBroker";
export type { IBroker } from "./broker/IBroker";

export { PostgreSQLStore } from "./store/PostgreSQLStore";
export { SQLiteStore } from "./store/SQLiteStore";
export { InMemoryStore } from "./store/InMemoryStore";
export type { IStore } from "./store/IStore";

export { createServer, startServer } from "./server/createServer";

export { RetryManager } from "./retry/RetryManager";
export { DLQManager } from "./dlq/DLQManager";
export { HealthCheck } from "./monitoring/HealthCheck";

// Convenient default instance for `import { queue } from 'queueway'`.
// Automatically picks up ./queueway.config.js (created by `queueway init`)
// if present, so a plain `require('queueway').queue` is already configured
// the way the developer chose — no manual `new Queueway(config)` needed.
import fs from "fs";
import path from "path";
import { Queueway } from "./Queueway";
import { logger } from "./logging/Logger";

function loadProjectConfig(): Partial<import("./types").QueuewayConfig> {
  try {
    const configPath = path.resolve(process.cwd(), "queueway.config.js");
    if (fs.existsSync(configPath)) {
      return require(configPath);
    }
  } catch (err) {
    logger.warn('⚠️  Found queueway.config.js but failed to load it, using defaults', { error: String(err) });
  }
  return {};
}

export const queue = new Queueway(loadProjectConfig());
