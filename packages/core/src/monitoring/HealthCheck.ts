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

/** Real health check — actually pings the configured broker + database. */
export class HealthCheck {
  constructor(private broker: IBroker, private store: IStore) {}

  async getStatus(): Promise<HealthStatus> {
    const [broker, database] = await Promise.all([
      this.broker.checkHealth(),
      this.store.checkHealth(),
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
