#!/usr/bin/env node
/**
 * Queueway — Redis broker test (Milestone 2, Part 3)
 * ---------------------------------------------------
 * Store stays PostgreSQL throughout, because that's the only pairing that
 * makes sense: Redis exists to run several workers, and several workers need
 * a store they can all reach.
 *
 * What this checks, in order of how much it matters:
 *   1. jobs actually travel through Redis (not silently through memory)
 *   2. several workers share the load, and no job runs twice
 *   3. a job survives the worker that was holding it being killed
 *   4. Redis going away doesn't take the process down, and it reconnects
 *
 * Prereq: a Redis and a PostgreSQL, via `queueway init` or docker-compose.dev.yml.
 *   REDIS_URL=redis://localhost:6379
 *   DATABASE_URL=postgres://...
 *
 * Run:
 *   node scripts/redis-test.js
 *
 * Destructive: DROPs queueway_jobs/queueway_workers and deletes its own
 * queueway:queue:redis.* keys. Never point it at anything real.
 */

const assert = require("assert");
const path = require("path");

try {
  require(require.resolve("dotenv", {
    paths: [path.resolve(__dirname, "..", "packages", "core"), path.resolve(__dirname, "..")],
  })).config();
} catch {}

const REDIS_URL = process.env.QUEUEWAY_REDIS_URL || process.env.REDIS_URL || "redis://localhost:6379";
const DB_URL =
  process.env.QUEUEWAY_DATABASE_URL || process.env.DATABASE_URL || "postgres://queueway:devpassword@localhost:5432/queueway";
process.env.QUEUEWAY_REDIS_URL = REDIS_URL;
process.env.QUEUEWAY_DATABASE_URL = DB_URL;

const corePath = path.resolve(__dirname, "..", "packages", "core");
const resolveFrom = (mod) =>
  require(require.resolve(mod, { paths: [corePath, path.resolve(__dirname, "..")] }));

const { Queueway } = require(path.join(corePath, "dist", "index.js"));
const { Pool } = resolveFrom("pg");
const Redis = resolveFrom("ioredis");

const { execFileSync } = require("child_process");

// Don't autoload the project's own queueway.jobs.js — these tests register
// their own handlers, and running the real ones would be both noisy and wrong.
process.env.QUEUEWAY_SKIP_JOBS_FILE = "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`   ✅ ${m}`);
};

// The process staying alive through all of this is itself part of the test.
process.on("uncaughtException", (err) => {
  console.error(`\n❌ CRASHED: ${err.message}\n`);
  process.exit(1);
});

const admin = new Pool({ connectionString: DB_URL });
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
redis.on("error", () => {});

const FAST_RETRY = { maxAttempts: 3, strategy: "exponential", baseDelay: 200 };

async function main() {
  console.log("\n🔴 Queueway — Redis broker test");
  console.log(`   broker: ${REDIS_URL}`);
  console.log(`   store:  ${DB_URL.replace(/:[^:@]+@/, ":****@")}\n`);

  await admin.query("DROP TABLE IF EXISTS queueway_jobs, queueway_workers");
  const stale = await redis.keys("queueway:queue:redis.*");
  if (stale.length) await redis.del(...stale);

  // =====================================================================
  console.log("3.1 Smoke test — a job really travels through Redis");

  const queue = new Queueway({ broker: "redis", store: "postgres", retry: FAST_RETRY });
  const seen = [];
  queue.subscribe("redis.smoke", async (job) => seen.push(job.data));
  await queue.start();
  await sleep(500); // let the BRPOP loop attach

  const payload = { hello: "redis", nested: { a: [1, 2, 3] } };
  const jobId = await queue.publish("redis.smoke", payload);

  // publish() returns as soon as Redis accepts it — delivery is asynchronous,
  // which is exactly the difference from the in-memory broker.
  for (let i = 0; i < 40 && seen.length === 0; i++) await sleep(100);

  assert.strictEqual(seen.length, 1, "handler never ran");
  assert.deepStrictEqual(seen[0], payload, "payload changed in transit");
  ok("job delivered through Redis with its payload intact");

  await sleep(300);
  const stored = await queue.getJob(jobId);
  assert.strictEqual(stored.status, "completed", `expected completed, got ${stored.status}`);
  ok("job recorded as completed in PostgreSQL");

  const keyAfter = await redis.llen("queueway:queue:redis.smoke");
  assert.strictEqual(keyAfter, 0, "the Redis list should be empty once consumed");
  ok("Redis list drained (BRPOP consumed it)");

  // =====================================================================
  console.log("\n3.2 Multi-worker — the whole reason Redis exists");

  const ranBy = new Map(); // jobId -> [workers]
  const workers = [];
  for (const name of ["A", "B", "C"]) {
    const w = new Queueway({ broker: "redis", store: "postgres", retry: FAST_RETRY });
    w.subscribe("redis.spread", async (job) => {
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
    await workers[0].queue.publish("redis.spread", { i });
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
  assert.ok(usedWorkers > 1, `only one worker did any work: ${JSON.stringify(perWorker)}`);
  ok(`work spread across ${usedWorkers} workers (A:${perWorker.A} B:${perWorker.B} C:${perWorker.C})`);

  // =====================================================================
  console.log("\n3.3 Durability — BRPOP removes the job, so the store must save it");

  // Redis has no message-level ack: BRPOP deletes the entry immediately. If a
  // worker dies mid-handler the job is already gone from Redis, and only the
  // store's record of it can bring it back.
  const orphanId = "00000000-0000-4000-8000-00000000dead";
  await admin.query(
    `INSERT INTO queueway_jobs (id, event_name, data, status, attempts, worker_id, locked_at)
     VALUES ($1, 'redis.orphan', '{"i":999}'::jsonb, 'processing', 0, 'worker-that-died',
             NOW() - interval '10 minutes')`,
    [orphanId],
  );
  ok("left a job as a killed worker would: gone from Redis, 'processing' in the store");

  const rescuer = new Queueway({ broker: "redis", store: "postgres", retry: FAST_RETRY });
  const rescued = [];
  rescuer.subscribe("redis.orphan", async (job) => rescued.push(job.id));
  await rescuer.start();

  for (let i = 0; i < 60 && !rescued.includes(orphanId); i++) await sleep(200);
  assert.ok(rescued.includes(orphanId), "the dead worker's job was never recovered");
  ok("recovered through the store and re-published to Redis");

  const orphanRow = await admin.query("SELECT status FROM queueway_jobs WHERE id = $1", [orphanId]);
  assert.strictEqual(orphanRow.rows[0].status, "completed", "recovered job didn't complete");
  ok("recovered job ran to completion");

  // The other side of the same coin: a live worker's job is left alone.
  const liveDuplicates = [...ranBy.entries()].filter(([, l]) => l.length > 1);
  assert.strictEqual(liveDuplicates.length, 0, "recovery re-ran a job that was already done");
  ok("recovery didn't disturb jobs belonging to the running workers");

  // =====================================================================
  console.log("\n3.4 Retry + DLQ over Redis");

  const failer = new Queueway({ broker: "redis", store: "postgres", retry: FAST_RETRY });
  let attempts = 0;
  failer.subscribe("redis.fail", async () => {
    attempts++;
    throw new Error("always fails");
  });
  await failer.start();
  await sleep(500);

  const failId = await failer.publish("redis.fail", { n: 1 });
  for (let i = 0; i < 60 && attempts < 3; i++) await sleep(100);
  await sleep(500);

  assert.strictEqual(attempts, 3, `expected 3 attempts, got ${attempts}`);
  ok("retried exactly maxAttempts times");

  const failRow = await admin.query("SELECT status, attempts FROM queueway_jobs WHERE id = $1", [
    failId,
  ]);
  assert.strictEqual(failRow.rows[0].status, "failed", "did not end as failed");
  ok("ended as failed and moved to the DLQ");

  // =====================================================================
  console.log("\n3.5 Outage — Redis goes away and comes back");

  // Only ever touch the Redis this test is actually connected to, and only
  // when it's a container we can stop and start again. Running `redis-cli
  // shutdown` would kill whatever Redis happens to be on the default port —
  // quite possibly one the developer needs — and on Windows it can't be
  // started again from here anyway.
  const redisPort = Number(new URL(REDIS_URL).port || 6379);
  const redisContainer = findContainerByPort(redisPort);

  if (!redisContainer) {
    console.log(
      `   ⏭️  skipped — no Docker container found publishing port ${redisPort}.\n` +
        `      This test only stops a Redis it can safely start again.`,
    );
  } else {
    const outageQueue = new Queueway({ broker: "redis", store: "postgres", retry: FAST_RETRY });
    const afterOutage = [];
    outageQueue.subscribe("redis.outage", async (job) => afterOutage.push(job.data.n));
    await outageQueue.start();
    await sleep(600);

    console.log(`   (stopping container ${redisContainer})`);
    docker("stop", redisContainer);
    await sleep(4000);
    ok("process survived Redis disappearing");

    let rejected = false;
    try {
      await outageQueue.publish("redis.outage", { n: 1 });
    } catch {
      rejected = true;
    }
    assert.ok(rejected, "publish() should reject while Redis is unreachable, not hang");
    ok("publish() rejects instead of hanging");

    const downHealth = await outageQueue.getHealth();
    assert.strictEqual(downHealth.components.broker.status, "down", "broker should report down");
    assert.strictEqual(downHealth.components.database.status, "up", "database should still be up");
    ok("health reports the broker down and the database up");

    console.log(`   (starting container ${redisContainer})`);
    docker("start", redisContainer);
    await sleep(6000);

    let back = false;
    for (let i = 0; i < 15; i++) {
      try {
        await outageQueue.publish("redis.outage", { n: 2 });
        back = true;
        break;
      } catch {
        await sleep(2000);
      }
    }
    assert.ok(back, "never reconnected after Redis came back");
    for (let i = 0; i < 50 && !afterOutage.includes(2); i++) await sleep(200);
    assert.ok(afterOutage.includes(2), "reconnected but stopped consuming");
    ok("reconnected on its own and resumed consuming — no restart needed");

    await outageQueue.stop();
  }

  // =====================================================================
  console.log("\n3.6 Health");

  const health = await queue.getHealth();
  assert.strictEqual(health.components.broker.status, "up", "broker should be up");
  assert.strictEqual(health.components.database.status, "up", "database should be up");
  ok(`broker up (${health.components.broker.latency}ms), database up`);

  for (const w of workers) await w.queue.stop();
  await rescuer.stop();
  await failer.stop();
  await queue.stop();

  console.log(
    `\n✅ REDIS TESTS PASSED — ${passed} checks. Jobs are distributed, never duplicated, never lost.\n`,
  );
}

main()
  .then(async () => {
    await admin.end();
    redis.disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`\n❌ REDIS TEST FAILED after ${passed} passing checks`);
    console.error(`   ${err.message}\n`);
    try {
      await admin.end();
      redis.disconnect();
    } catch {}
    process.exit(1);
  });
