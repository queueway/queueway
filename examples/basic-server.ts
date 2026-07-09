/**
 * Minimal example: publish/subscribe + expose the REST API + basic dashboard data.
 *
 * Run with: npx ts-node examples/basic-server.ts
 * Then visit: http://localhost:4287/queueway/stats
 */
import { Queueway, startServer } from "queueway";

async function main() {
  const queue = new Queueway({ broker: "in-memory", store: "in-memory" });

  queue.subscribe("email.send", async (job) => {
    console.log("Processing email job:", job.data);
  });

  await queue.start();
  await startServer(queue, 4287);

  // Simulate some traffic
  await queue.publish("email.send", {
    to: "user@example.com",
    subject: "Welcome!",
  });
}

main().catch(console.error);
