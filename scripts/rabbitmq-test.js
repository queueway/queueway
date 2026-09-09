#!/usr/bin/env node
/**
 * Queueway — RabbitMQ broker test (Milestone 3)
 * ----------------------------------------------
 * Mirrors scripts/redis-test.js so the two are directly comparable. The store
 * stays PostgreSQL throughout, for the same reason: RabbitMQ exists to run
 * several workers, and several workers need a store they can all reach.
 *
 * What this checks, in order of how much it matters:
 *   1. jobs actually travel through RabbitMQ (not silently through memory)
 *   2. several workers share the load, and no job runs twice
 *   3. a worker dying returns its in-flight job to the queue — and the store
 *      does NOT also re-publish it, which would run the job twice
 *   4. a retry backoff does not hold the delivery unacked and block the queue
 *   5. a rejected message is dead-lettered, never destroyed
 *   6. RabbitMQ going away doesn't take the process down, and it reconnects
 *
 * Prereq: a RabbitMQ and a PostgreSQL, via `queueway init` or docker-compose.dev.yml.
 *   QUEUEWAY_RABBITMQ_URL=amqp://user:pass@localhost:5672
 *   QUEUEWAY_DATABASE_URL=postgres://...
 *
 * Run:
 *   node scripts/rabbitmq-test.js
 *
 * Destructive: DROPs queueway_jobs/queueway_workers and deletes its own
 * queueway.rabbit.* queues. Never point it at anything real.
 */

const assert = require("assert");
const path = require("path");

try {
  require(require.resolve("dotenv", {
    paths: [path.resolve(__dirname, "..", "packages", "core"), path.resolve(__dirname, "..")],
  })).config();
} catch { }

const RABBIT_URL =
  process.env.QUEUEWAY_RABBITMQ_URL || process.env.RABBITMQ_URL || "amqp://localhost:5672";
const DB_URL =
  process.env.QUEUEWAY_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://queueway:devpassword@localhost:5432/queueway";
process.env.QUEUEWAY_RABBITMQ_URL = RABBIT_URL;
process.env.QUEUEWAY_DATABASE_URL = DB_URL;

const corePath = path.resolve(__dirname, "..", "packages", "core");
const resolveFrom = (mod) =>
  require(require.resolve(mod, { paths: [corePath, path.resolve(__dirname, "..")] }));

const { Queueway } = require(path.join(corePath, "dist", "index.js"));
const { RabbitMQBroker } = require(path.join(corePath, "dist", "broker", "RabbitMQBroker.js"));
const { Pool } = resolveFrom("pg");
const amqp = resolveFrom("amqplib");

const { execFileSync } = require("child_process");

// Don't autoload the project's own queueway.jobs.js — these tests register
// their own handlers, and running the real ones would be both noisy and wrong.
process.env.QUEUEWAY_SKIP_JOBS_FILE = "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`   ✅ ${m}`);
};
const skip = (m) => console.log(`   ⏭️  ${m}`);

// The process staying alive through all of this is itself part of the test.
process.on("uncaughtException", (err) => {
  console.error(`\n❌ CRASHED: ${err.message}\n`);
  process.exit(1);
});

const admin = new Pool({ connectionString: DB_URL });

/** The container publishing a given host port, if there is one. */
function findContainerByPort(port) {
  try {
    const out = execFileSync(
      "docker",
      ["ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim().split("\n").filter(Boolean)[0] || null;
  } catch {
    return null; // no Docker, or nothing on that port
  }
}

function docker(action, container) {
  execFileSync("docker", [action, container], { stdio: ["ignore", "ignore", "ignore"] });
}

/** A minimal job record, for the tests that drive the broker directly. */
let jobCounter = 0;
function makeJob(eventName, data) {
  jobCounter += 1;
  return {
    id: `99999999-0000-4000-8000-${String(jobCounter).padStart(12, "0")}`,
    eventName,
    data,
    status: "pending",
    attempts: 0,
    createdAt: new Date(),
  };
}

/**
 * Cuts the TCP socket out from under a live connection.
 *
 * This is what a network blip actually looks like to the client, it needs
 * neither Docker nor rabbitmqctl, and it works the same on Windows, macOS and
 * Linux — so the reconnect loop, which is the largest piece of work in this
 * milestone, is verifiable on every machine rather than only where containers
 * happen to be running.
 */
function cutSocket(broker) {
  const socket = broker?.connection?.connection?.stream;
  if (!socket || typeof socket.destroy !== "function") return false;
  socket.destroy(new Error("simulated network cut"));
  return true;
}

/**
 * Message counts, read on a throwaway channel. checkQueue closes the channel it
 * runs on if the queue is missing, so it must never share one with anything
 * that matters.
 */
async function queueStats(conn, name) {
  const ch = await conn.createChannel();
  ch.on("error", () => { });
  try {
    const info = await ch.checkQueue(name);
    await ch.close().catch(() => { });
    return { messages: info.messageCount, consumers: info.consumerCount };
  } catch {
    return null; // queue doesn't exist
  }
}

async function deleteQueues(conn, names) {
  for (const name of names) {
    const ch = await conn.createChannel();
    ch.on("error", () => { });
    try {
      await ch.deleteQueue(name);
    } catch { }
    await ch.close().catch(() => { });
  }
}

const FAST_RETRY = { maxAttempts: 3, strategy: "exponential", baseDelay: 200 };

async function main() {
  console.log("\n🐇 Queueway — RabbitMQ broker test");
  console.log(`   broker: ${RABBIT_URL.replace(/:[^:@]+@/, ":****@")}`);
  console.log(`   store:  ${DB_URL.replace(/:[^:@]+@/, ":****@")}\n`);

  await admin.query("DROP TABLE IF EXISTS queueway_jobs, queueway_workers");

  const inspector = await amqp.connect(RABBIT_URL);
  inspector.on("error", () => { });

  // Queues from an earlier run may predate dead-lettering; a mismatched
  // declaration fails with 406 and would take the first subscription with it.
  await deleteQueues(inspector, [
    "queueway.rabbit.smoke",
    "queueway.rabbit.confirm",
    "queueway.rabbit.spread",
    "queueway.rabbit.orphan",
    "queueway.rabbit.redeliver",
    "queueway.rabbit.fail",
    "queueway.rabbit.block",
    "queueway.rabbit.reject",
    "queueway.rabbit.reconnect",
    "queueway.rabbit.outage",
    "queueway.dead.rabbit.reject",
  ]);

  // =====================================================================
  console.log("4.1 Smoke test — a job really travels through RabbitMQ");

  const queue = new Queueway({ broker: "rabbitmq", store: "postgres", retry: FAST_RETRY });
  const seen = [];
  queue.subscribe("rabbit.smoke", async (job) => seen.push(job.data));
  await queue.start();
  await sleep(300);

  const payload = { hello: "rabbit", nested: { a: [1, 2, 3] } };
  const jobId = await queue.publish("rabbit.smoke", payload);

  for (let i = 0; i < 40 && seen.length === 0; i++) await sleep(100);

  assert.strictEqual(seen.length, 1, "handler never ran");
  assert.deepStrictEqual(seen[0], payload, "payload changed in transit");
  ok("job delivered through RabbitMQ with its payload intact");

  await sleep(300);
  const stored = await queue.getJob(jobId);
  assert.strictEqual(stored.status, "completed", `expected completed, got ${stored.status}`);
  ok("job recorded as completed in PostgreSQL");

  const smokeStats = await queueStats(inspector, "queueway.rabbit.smoke");
  assert.ok(smokeStats, "the durable queue was never declared");
  assert.strictEqual(smokeStats.messages, 0, "the queue should be empty once acked");
  ok("queue drained — the message was acknowledged, not just delivered");

  // The dead-letter exchange is what stops nack() from destroying a message.
  const dlxCh = await inspector.createChannel();
  dlxCh.on("error", () => { });
  await dlxCh.checkExchange("queueway.dlx");
  await dlxCh.close().catch(() => { });
  ok("dead-letter exchange queueway.dlx exists");

  // =====================================================================
  console.log("\n4.2 Publisher confirms — publish() waits for the broker, not the socket");

  // A plain channel.publish() returns a boolean about its own write buffer and
  // reports success even when the broker never took the message. With confirms,
  // publish() resolving means RabbitMQ has it — so the count must already be
  // there the instant the loop finishes, with nothing consuming.
  const confirmCh = await inspector.createChannel();
  await confirmCh.assertQueue("queueway.rabbit.confirm", {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": "queueway.dlx",
      "x-dead-letter-routing-key": "rabbit.confirm",
    },
  });
  await confirmCh.bindQueue("queueway.rabbit.confirm", "queueway", "rabbit.confirm");
  await confirmCh.close().catch(() => { });

  const CONFIRMS = 200;
  for (let i = 0; i < CONFIRMS; i++) {
    await queue.publish("rabbit.confirm", { i });
  }
  const confirmStats = await queueStats(inspector, "queueway.rabbit.confirm");
  assert.strictEqual(
    confirmStats.messages,
    CONFIRMS,
    `only ${confirmStats.messages}/${CONFIRMS} messages had reached the broker when publish() resolved`,
  );
  ok(`all ${CONFIRMS} publishes confirmed by the broker before resolving`);

  // =====================================================================
  console.log("\n4.3 Multi-worker — prefetch is what makes the load spread");

  const ranBy = new Map(); // jobId -> [workers]
  const workers = [];
  for (const name of ["A", "B", "C"]) {
    const w = new Queueway({ broker: "rabbitmq", store: "postgres", retry: FAST_RETRY });
    w.subscribe("rabbit.spread", async (job) => {
      const list = ranBy.get(job.id) ?? [];
      list.push(name);
      ranBy.set(job.id, list);
      await sleep(20);
    });
    await w.start();
    workers.push({ name, queue: w });
  }
  await sleep(700);

  const COUNT = 60;
  for (let i = 0; i < COUNT; i++) {
    await workers[0].queue.publish("rabbit.spread", { i });
  }

  for (let i = 0; i < 100 && ranBy.size < COUNT; i++) await sleep(100);

  assert.strictEqual(ranBy.size, COUNT, `only ${ranBy.size}/${COUNT} jobs ran`);
  ok(`all ${COUNT} jobs ran`);

  const duplicated = [...ranBy.entries()].filter(([, list]) => list.length > 1);
  assert.strictEqual(
    duplicated.length,
    0,
    `${duplicated.length} job(s) ran more than once — e.g. ${duplicated[0]?.[1].join(", ")}`,
  );
  ok("no job ran twice");

  const perWorker = { A: 0, B: 0, C: 0 };
  for (const list of ranBy.values()) perWorker[list[0]]++;
  const usedWorkers = Object.values(perWorker).filter((n) => n > 0).length;
  const busiest = Math.max(...Object.values(perWorker));
  assert.ok(usedWorkers > 1, `only one worker did any work: ${JSON.stringify(perWorker)}`);
  assert.ok(
    busiest < COUNT * 0.75,
    `one worker took ${busiest}/${COUNT} — prefetch isn't spreading the load: ${JSON.stringify(perWorker)}`,
  );
  ok(`work spread across ${usedWorkers} workers (A:${perWorker.A} B:${perWorker.B} C:${perWorker.C})`);

  // =====================================================================
  console.log("\n4.4 Durability — the broker redelivers, so the store must NOT");

  // This is the difference from Redis, and the subtlest bug in the milestone.
  // Redis' BRPOP removes the job on delivery, so a dead worker's job can only
  // come back through the store. RabbitMQ still holds the unacked message and
  // hands it to someone else by itself — recovering it from the store as well
  // would run it twice.
  const orphanId = "00000000-0000-4000-8000-00000000dead";
  await admin.query(
    `INSERT INTO queueway_jobs (id, event_name, data, status, attempts, worker_id, locked_at)
     VALUES ($1, 'rabbit.orphan', '{"i":999}'::jsonb, 'processing', 0, 'worker-that-died',
             NOW() - interval '10 minutes')`,
    [orphanId],
  );

  const rescuer = new Queueway({ broker: "rabbitmq", store: "postgres", retry: FAST_RETRY });
  const rescued = [];
  rescuer.subscribe("rabbit.orphan", async (job) => rescued.push(job.id));
  await rescuer.start();
  await sleep(2500);

  assert.strictEqual(
    rescued.length,
    0,
    "the store re-published a 'processing' job — RabbitMQ is already redelivering it, so this is a duplicate",
  );
  ok("store recovery left the in-flight job to the broker (no duplicate)");

  const orphanRow = await admin.query("SELECT status FROM queueway_jobs WHERE id = $1", [orphanId]);
  assert.strictEqual(
    orphanRow.rows[0].status,
    "processing",
    "the row should be untouched — the broker owns this one",
  );
  ok("the orphan row was left alone rather than claimed");

  // And the real thing: a worker holding an unacked message disappears.
  const holder = new RabbitMQBroker();
  let held = 0;
  holder.subscribe("rabbit.redeliver", async () => {
    held++;
    await new Promise(() => { }); // never returns — this worker is wedged, then dies
  });
  await holder.connect();
  await sleep(300);

  const publisher = new RabbitMQBroker();
  await publisher.connect();
  await publisher.publish("rabbit.redeliver", {
    id: "11111111-0000-4000-8000-000000000001",
    eventName: "rabbit.redeliver",
    data: { n: 1 },
    status: "pending",
    attempts: 0,
    createdAt: new Date(),
  });

  for (let i = 0; i < 40 && held === 0; i++) await sleep(100);
  assert.strictEqual(held, 1, "the first worker never received the job");

  const heldStats = await queueStats(inspector, "queueway.rabbit.redeliver");
  assert.strictEqual(heldStats.messages, 0, "message should be unacked with the worker, not queued");
  ok("message held unacked by the worker that is processing it");

  await holder.disconnect(); // the worker dies with the message unacked
  await sleep(500);

  const afterDeath = await queueStats(inspector, "queueway.rabbit.redeliver");
  assert.strictEqual(
    afterDeath.messages,
    1,
    "RabbitMQ did not return the unacked message to the queue",
  );
  ok("RabbitMQ returned the unacked message to the queue by itself");

  const taker = new RabbitMQBroker();
  const takenBy = [];
  taker.subscribe("rabbit.redeliver", async (job) => takenBy.push(job.data.n));
  await taker.connect();
  for (let i = 0; i < 40 && takenBy.length === 0; i++) await sleep(100);

  assert.deepStrictEqual(takenBy, [1], `expected exactly one redelivery, got ${takenBy.length}`);
  ok("another worker picked it up — exactly once, no store involvement");

  await taker.disconnect();
  await publisher.disconnect();

  // =====================================================================
  console.log("\n4.5 Retry + DLQ over RabbitMQ");

  const failer = new Queueway({ broker: "rabbitmq", store: "postgres", retry: FAST_RETRY });
  let attempts = 0;
  failer.subscribe("rabbit.fail", async () => {
    attempts++;
    throw new Error("always fails");
  });
  await failer.start();
  await sleep(400);

  const failId = await failer.publish("rabbit.fail", { n: 1 });
  for (let i = 0; i < 80 && attempts < 3; i++) await sleep(100);
  await sleep(800);

  assert.strictEqual(attempts, 3, `expected 3 attempts, got ${attempts}`);
  ok("retried exactly maxAttempts times");

  const failRow = await admin.query("SELECT status, attempts FROM queueway_jobs WHERE id = $1", [
    failId,
  ]);
  assert.strictEqual(failRow.rows[0].status, "failed", "did not end as failed");
  ok("ended as failed and moved to the DLQ");

  // =====================================================================
  console.log("\n4.6 A retry backoff must not block the queue behind it");

  // With prefetch 1 and the backoff waited out inside the delivery, this worker
  // would sit unable to take anything else for the whole delay.
  const blocker = new Queueway({
    broker: "rabbitmq",
    store: "postgres",
    retry: { maxAttempts: 3, strategy: "exponential", baseDelay: 2000 },
  });
  const order = [];
  let blockFails = 0;
  blocker.subscribe("rabbit.block", async (job) => {
    if (job.data.fail) {
      blockFails++;
      throw new Error("fails once, then backs off for 4s");
    }
    order.push(job.data.i);
  });
  await blocker.start();
  await sleep(400);

  await blocker.publish("rabbit.block", { fail: true });
  for (let i = 0; i < 5; i++) await blocker.publish("rabbit.block", { i });

  for (let i = 0; i < 30 && order.length < 5; i++) await sleep(100);
  assert.strictEqual(order.length, 5, `only ${order.length}/5 fast jobs got through the backoff`);
  ok("the 5 jobs behind it ran while the failing job waited out its backoff");

  const blockStats = await queueStats(inspector, "queueway.rabbit.block");
  assert.strictEqual(
    blockStats.messages + (blockStats.unacked ?? 0),
    0,
    "something is still sitting in the queue during the backoff",
  );
  ok("nothing left unacknowledged while the retry waits");

  await sleep(5000);
  assert.ok(blockFails >= 2, `the scheduled retry never fired (attempts: ${blockFails})`);
  ok("the retry did fire after its delay — the wait was moved, not lost");

  // =====================================================================
  console.log("\n4.7 A rejected message is dead-lettered, never destroyed");

  // Queueway handles its own retries, so a throw reaching the broker means the
  // retry path itself failed — a store write during an outage, typically.
  // Without a dead-letter exchange, nack(requeue=false) deletes the message.
  const rejecter = new RabbitMQBroker();
  rejecter.subscribe("rabbit.reject", async () => {
    throw new Error("retry path itself failed");
  });
  await rejecter.connect();
  await sleep(300);

  const rejectPublisher = new RabbitMQBroker();
  await rejectPublisher.connect();
  await rejectPublisher.publish("rabbit.reject", {
    id: "22222222-0000-4000-8000-000000000002",
    eventName: "rabbit.reject",
    data: { n: 1 },
    status: "pending",
    attempts: 0,
    createdAt: new Date(),
  });
  await sleep(1200);

  const dead = await queueStats(inspector, "queueway.dead.rabbit.reject");
  assert.ok(dead, "the dead-letter queue was never declared");
  assert.strictEqual(dead.messages, 1, "the rejected message was destroyed instead of dead-lettered");
  ok("rejected message landed in queueway.dead.rabbit.reject");

  const live = await queueStats(inspector, "queueway.rabbit.reject");
  assert.strictEqual(live.messages, 0, "the message was requeued into a loop instead");
  ok("it was not requeued into an endless redelivery loop");

  await rejecter.disconnect();
  await rejectPublisher.disconnect();

  // =====================================================================
  console.log("\n4.8 Reconnect — the connection is cut underneath a running worker");

  // amqplib never reconnects by itself: without the reconnect loop the worker
  // survives the drop but stops consuming forever. This runs everywhere — no
  // Docker, no rabbitmqctl — so the milestone's biggest fix is always proven.
  const netBroker = new RabbitMQBroker();
  const netSeen = [];
  netBroker.subscribe("rabbit.reconnect", async (job) => netSeen.push(job.data.n));
  await netBroker.connect();
  await sleep(400);

  await netBroker.publish("rabbit.reconnect", makeJob("rabbit.reconnect", { n: 1 }));
  for (let i = 0; i < 40 && !netSeen.includes(1); i++) await sleep(100);
  assert.ok(netSeen.includes(1), "the worker wasn't consuming before the cut");

  assert.ok(cutSocket(netBroker), "could not reach the socket to cut it");
  console.log("   (cut the TCP socket out from under the connection)");
  await sleep(2000);
  ok("process survived the connection being cut");

  let netBack = false;
  for (let i = 0; i < 30; i++) {
    try {
      await netBroker.publish("rabbit.reconnect", makeJob("rabbit.reconnect", { n: 2 }));
      netBack = true;
      break;
    } catch {
      await sleep(1000);
    }
  }
  assert.ok(netBack, "never reconnected — amqplib does not do this by itself");
  ok("reconnected on its own, with no restart");

  for (let i = 0; i < 60 && !netSeen.includes(2); i++) await sleep(200);
  assert.ok(
    netSeen.includes(2),
    "reconnected but stopped consuming — the subscriptions were not re-bound",
  );
  ok("subscriptions re-bound after the reconnect — consuming resumed");

  await netBroker.disconnect();

  // =====================================================================
  console.log("\n4.8b Full outage — the broker itself goes away and comes back");

  const rabbitPort = Number(new URL(RABBIT_URL).port || 5672);
  const container = findContainerByPort(rabbitPort);

  const outageQueue = new Queueway({ broker: "rabbitmq", store: "postgres", retry: FAST_RETRY });
  const afterOutage = [];
  outageQueue.subscribe("rabbit.outage", async (job) => afterOutage.push(job.data.n));
  await outageQueue.start();
  await sleep(500);

  let outageSimulated = false;

  if (container) {
    outageSimulated = true;
    console.log(`   (stopping container ${container})`);
    docker("stop", container);
    await sleep(4000);
    ok("process survived RabbitMQ disappearing");

    let rejected = false;
    try {
      await outageQueue.publish("rabbit.outage", { n: 1 });
    } catch {
      rejected = true;
    }
    assert.ok(rejected, "publish() should reject while RabbitMQ is unreachable, not hang");
    ok("publish() rejects instead of hanging");

    const downHealth = await outageQueue.getHealth();
    assert.strictEqual(downHealth.components.broker.status, "down", "broker should report down");
    assert.strictEqual(downHealth.components.database.status, "up", "database should still be up");
    ok("health reports the broker down and the database up");

    console.log(`   (starting container ${container})`);
    docker("start", container);
    await sleep(15000);
  } else {
    skip(
      `skipped — no Docker container publishing port ${rabbitPort}.\n` +
      `      This test only stops a RabbitMQ it can safely start again; 4.8 already\n` +
      `      proved the reconnect itself. Run it once with Docker before release, so\n` +
      `      "publish() rejects" and "health reports down" are proven too.`,
    );
  }

  if (outageSimulated) {
    let back = false;
    for (let i = 0; i < 30; i++) {
      try {
        await outageQueue.publish("rabbit.outage", { n: 2 });
        back = true;
        break;
      } catch {
        await sleep(2000);
      }
    }
    assert.ok(back, "never reconnected after RabbitMQ came back");
    ok("reconnected on its own — amqplib does not do this by itself");

    for (let i = 0; i < 60 && !afterOutage.includes(2); i++) await sleep(200);
    assert.ok(
      afterOutage.includes(2),
      "reconnected but stopped consuming — the subscriptions were not re-bound",
    );
    ok("subscriptions re-bound after the reconnect — consuming resumed, no restart needed");
  }

  await outageQueue.stop();

  // =====================================================================
  console.log("\n4.9 Health");

  const health = await queue.getHealth();
  assert.strictEqual(health.components.broker.status, "up", "broker should be up");
  assert.strictEqual(health.components.broker.type, "rabbitmq", "broker type should be rabbitmq");
  assert.strictEqual(health.components.database.status, "up", "database should be up");
  ok(`broker up (${health.components.broker.latency}ms, type=rabbitmq), database up`);

  for (const w of workers) await w.queue.stop();
  await rescuer.stop();
  await failer.stop();
  await blocker.stop();
  await queue.stop();
  await inspector.close().catch(() => { });

  console.log(
    `\n✅ RABBITMQ TESTS PASSED — ${passed} checks. Acknowledged, redelivered once, never destroyed.\n`,
  );
}

main()
  .then(async () => {
    await admin.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`\n❌ RABBITMQ TEST FAILED after ${passed} passing checks`);
    console.error(`   ${err.message}\n`);
    try {
      await admin.end();
    } catch { }
    process.exit(1);
  });