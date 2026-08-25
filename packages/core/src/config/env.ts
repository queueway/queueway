/**
 * Connection settings, read from the environment.
 *
 * Queueway's own variables are all prefixed `QUEUEWAY_`. That matters because
 * `DATABASE_URL` and `REDIS_URL` are among the most commonly used names in
 * Node projects — they usually already belong to the application itself. A
 * queue library must never take those over: writing to them would repoint the
 * app's own database.
 *
 * The unprefixed names are still honoured as a fallback so setups from 0.0.2
 * keep working, but `queueway init` only ever writes the prefixed ones.
 */

function pick(prefixed: string, legacy: string): string | undefined {
  return process.env[prefixed] ?? process.env[legacy];
}

/** PostgreSQL connection string for the job store. */
export function databaseUrl(): string | undefined {
  return pick("QUEUEWAY_DATABASE_URL", "DATABASE_URL");
}

/** Redis connection string for the broker. */
export function redisUrl(): string | undefined {
  return pick("QUEUEWAY_REDIS_URL", "REDIS_URL");
}

/** RabbitMQ connection string for the broker. */
export function rabbitmqUrl(): string | undefined {
  return pick("QUEUEWAY_RABBITMQ_URL", "RABBITMQ_URL");
}

/** Override for where the SQLite file lives. */
export function sqlitePath(): string | undefined {
  return pick("QUEUEWAY_SQLITE_PATH", "SQLITE_PATH");
}

/** True when a legacy, unprefixed variable is doing the work. */
export function usingLegacyName(prefixed: string, legacy: string): boolean {
  return process.env[prefixed] === undefined && process.env[legacy] !== undefined;
}
