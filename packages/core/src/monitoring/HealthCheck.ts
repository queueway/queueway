import { IBroker } from '../broker/IBroker';
import { IStore } from '../store/IStore';
import { ComponentHealth } from '../types';

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  components: {
    broker: ComponentHealth;
    database: ComponentHealth;
    api: ComponentHealth;
  };
}

/**
 * A component that is down must not be able to hold up the health report.
 * Clients retry internally — ioredis, for instance, retries a command 20 times
 * before giving up, so a ping against a stopped Redis takes over ten seconds.
 * Long enough for the dashboard's own request to time out, which then shows
 * *everything* as down and hides which part actually broke.
 */
const COMPONENT_TIMEOUT_MS = 3000;

function withTimeout(check: Promise<ComponentHealth>): Promise<ComponentHealth> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ status: 'down', error: 'Health check timed out' }),
      COMPONENT_TIMEOUT_MS,
    );
    check
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        resolve({ status: 'down', error: err?.message ?? String(err) });
      });
  });
}

/** Real health check — actually pings the configured broker + database. */
export class HealthCheck {
  constructor(private broker: IBroker, private store: IStore) {}

  async getStatus(): Promise<HealthStatus> {
    // Independent and bounded: one component failing says nothing about the
    // others, and the whole report always comes back within the timeout.
    const [broker, database] = await Promise.all([
      withTimeout(this.broker.checkHealth()),
      withTimeout(this.store.checkHealth()),
    ]);

    const healthy = broker.status === 'up' && database.status === 'up';

    return {
      status: healthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      components: {
        broker,
        database,
        // If this code is executing at all, the API process itself is up.
        api: { status: 'up' },
      },
    };
  }
}
