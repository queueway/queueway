export { Queueway } from './Queueway';
export type { QueuewayConfig, Job, JobStatus } from './types';

export { InMemoryBroker } from './broker/InMemoryBroker';
export { RabbitMQBroker } from './broker/RabbitMQBroker';
export { RedisBroker } from './broker/RedisBroker';
export type { IBroker } from './broker/IBroker';

export { PostgreSQLStore } from './store/PostgreSQLStore';
export { SQLiteStore } from './store/SQLiteStore';
export { InMemoryStore } from './store/InMemoryStore';
export type { IStore } from './store/IStore';

export { createServer, startServer } from './server/createServer';

export { RetryManager } from './retry/RetryManager';
export { DLQManager } from './dlq/DLQManager';
export { HealthCheck } from './monitoring/HealthCheck';

// Convenient default instance for `import { queue } from 'queueway'`
import { Queueway } from './Queueway';
export const queue = new Queueway();
