/**
 * Minimal example: publish/subscribe + expose the REST API + basic dashboard data.
 *
 * Run with: npx ts-node examples/basic-server.ts
 * Then visit: http://localhost:3000/queuekit/stats
 */
import { QueueKit, startServer } from 'queuekit';

async function main() {
  const queue = new QueueKit({ broker: 'in-memory', store: 'in-memory' });

  queue.subscribe('email.send', async (job) => {
    console.log('Processing email job:', job.data);
  });

  await queue.start();
  startServer(queue, 3000);

  // Simulate some traffic
  await queue.publish('email.send', { to: 'user@example.com', subject: 'Welcome!' });
}

main().catch(console.error);
