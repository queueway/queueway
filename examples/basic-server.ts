/**
 * Minimal example: publish/subscribe + expose the REST API + dashboard,
 * all in one call.
 *
 * Run with: npx ts-node examples/basic-server.ts
 * Then visit: http://localhost:4287 — you'll be asked to create a
 * one-time dashboard account (the /queueway/* API routes require login).
 */
import { Queueway } from "queueway";

async function main() {
  const queue = new Queueway({ broker: "in-memory", store: "in-memory" });

  queue.subscribe("email.send", async (job) => {
    console.log("Processing email job:", job.data);
  });

  // withServer: true also boots the REST API + dashboard on the given port —
  // everything `queueway start` does, minus background mode/auto-heal.
  await queue.start({ withServer: true, port: 4287 });

  // Simulate some traffic
  await queue.publish("email.send", {
    to: "user@example.com",
    subject: "Welcome!",
  });
}

main().catch(console.error);
