import { SQLiteStore } from '../src/store/SQLiteStore';
import { Job } from '../src/types';

describe('SQLiteStore', () => {
  it('should save and retrieve a job', async () => {
    const store = new SQLiteStore(':memory:');
    await store.initialize();

    const job: Job = {
      id: 'job_1',
      eventName: 'test.event',
      data: { hello: 'world' },
      status: 'pending',
      attempts: 0,
      createdAt: new Date(),
    };

    await store.saveJob(job);
    const fetched = await store.getJob('job_1');

    expect(fetched).not.toBeNull();
    expect(fetched?.eventName).toBe('test.event');
    expect(fetched?.data).toEqual({ hello: 'world' });
  });

  it('should update job status', async () => {
    const store = new SQLiteStore(':memory:');
    await store.initialize();

    const job: Job = {
      id: 'job_2',
      eventName: 'test.event',
      data: {},
      status: 'pending',
      attempts: 0,
      createdAt: new Date(),
    };

    await store.saveJob(job);
    await store.updateJob('job_2', 'completed');
    const fetched = await store.getJob('job_2');

    expect(fetched?.status).toBe('completed');
  });
});
