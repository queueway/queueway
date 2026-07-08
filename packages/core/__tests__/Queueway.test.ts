import { Queueway } from '../src/Queueway';

describe('Queueway', () => {
  it('should initialize', () => {
    const q = new Queueway({ broker: 'in-memory' });
    expect(q).toBeDefined();
  });

  it('should publish a job and return a job id', async () => {
    const q = new Queueway({ broker: 'in-memory' });
    const jobId = await q.publish('test.event', { data: 'test' });
    expect(jobId).toBeDefined();
    expect(typeof jobId).toBe('string');
  });

  it('should deliver published job to subscriber', async () => {
    const q = new Queueway({ broker: 'in-memory' });
    await q.start();

    const received: any[] = [];
    q.subscribe('order.created', async (job) => {
      received.push(job.data);
    });

    await q.publish('order.created', { orderId: 42 });
    expect(received).toEqual([{ orderId: 42 }]);
  });

  it('should track job stats after processing', async () => {
    const q = new Queueway({ broker: 'in-memory', store: 'in-memory' });
    await q.start();

    q.subscribe('stats.test', async () => {
      /* succeeds */
    });

    await q.publish('stats.test', {});

    // publish triggers subscribe handlers synchronously via InMemoryBroker
    const stats = await q.getStats();
    expect(stats.total).toBe(1);
    expect(stats.jobs.completed).toBe(1);
  });
});
