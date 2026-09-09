#!/usr/bin/env node
/**
 * Queueway — Regression Baseline (Milestone 2 safety net)
 * ------------------------------------------------------
 * Locks in ONLY what already works today: In-Memory broker + SQLite store,
 * publish/subscribe, stats, health, retry → DLQ, crash-recovery, and the
 * dashboard-critical retryJob()/deleteJob() paths.
 *
 * Run it BEFORE touching anything, save the output, and re-run it after
 * every change. If it ever fails, stop and revert — Postgres/Redis/RabbitMQ
 * work is not allowed to break the setup that is already in production.
 *
 *   node scripts/regression-test.js
 *   node scripts/regression-test.js > baseline-before.txt 2>&1
 *
 * Uses a throwaway SQLite file, so your real .queueway/queueway.db is
 * never touched.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// --- isolate the test DB BEFORE requiring queueway ------------------------
// SQLiteStore reads SQLITE_PATH in its constructor, which runs at require
// time for the exported default `queue` instance.
const TEST_DB = path.join(
  os.tmpdir(),
  `queueway-regression-${Date.now()}.db`,
);
process.env.SQLITE_PATH = TEST_DB;

// --- resolve the LOCAL build, not whatever npm has installed --------------
function loadQueueway() {
  const local = path.resolve(__dirname, "..", "packages", "core", "dist", "index.js");
  if (fs.existsSync(local)) {
    console.log(`   using local build: packages/core/dist`);
    return require(local);
  }
  console.log(`   using installed package: queueway`);
  return require("queueway");
}

const { Queueway } = loadQueueway();

// --- tiny test harness ----------------------------------------------------
let passed = 0;
const t0 = Date.now();

function ok(name) {
  passed++;
  console.log(`   ✅ ${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("\n🧪 Queueway regression baseline");
  console.log("   broker: in-memory | store: sqlite");
  console.log(`   test db: ${TEST_DB}\n`);

  // =======================================================================
  // 1. Basic publish → subscribe → complete
  // =======================================================================
  console.log("1. Basic publish/subscribe");

  const queue = new Queueway({ broker: "in-memory", store: "sqlite" });
  const seen = [];

  queue.subscribe("test.ok", async (job) => {
    seen.push(job.data.n);
  });

  let failAttempts = 0;
  queue.subscribe("test.fail", async () => {
    failAttempts++;
    throw new Error("always fails");
  });

  await queue.start();

  const okId = await queue.publish("test.ok", { n: 1 });
  assert.deepStrictEqual(seen, [1], "handler did not run");
  ok("handler ran");

  const stored = await queue.getJob(okId);
  assert.ok(stored, "job was not persisted to SQLite");
  assert.strictEqual(stored.status, "completed", `expected completed, got ${stored.status}`);
  assert.strictEqual(stored.eventName, "test.ok", "eventName not persisted");
  assert.deepStrictEqual(stored.data, { n: 1 }, "job data not persisted correctly");
  ok("job persisted with status=completed");

  // =======================================================================
  // 2. Stats shape (powers /queueway/stats + the dashboard cards)
  // =======================================================================
  console.log("\n2. Stats");

  const stats = await queue.getStats();
  assert.ok(stats && stats.jobs, "getStats() returned no jobs object");
  for (const key of ["pending", "processing", "completed", "failed", "retrying", "archived"]) {
    assert.strictEqual(typeof stats.jobs[key], "number", `stats.jobs.${key} is not a number`);
  }
  assert.strictEqual(typeof stats.total, "number", "stats.total is not a number");
  assert.ok(stats.jobs.completed >= 1, "completed count did not increase");
  ok("all six status counters + total present");

  // =======================================================================
  // 3. Health check (real ping, not a hardcoded string)
  // =======================================================================
  console.log("\n3. Health");

  const health = await queue.getHealth();
  assert.strictEqual(health.status, "healthy", `health is ${health.status}`);
  assert.strictEqual(health.components.broker.status, "up", "broker not up");
  assert.strictEqual(health.components.database.status, "up", "database not up");
  assert.strictEqual(health.components.api.status, "up", "api not up");
  ok("broker + database + api all up");

  // =======================================================================
  // 4. Retry → DLQ  (~30s: backoff is 2s + 4s + 8s + 16s, capped at 30s)
  // =======================================================================
  console.log("\n4. Retry + DLQ  (this takes ~30s — the backoff is real)");

  const retryStart = Date.now();
  // With the in-memory broker, publish() runs handlers inline, so this
  // await only returns once the whole retry chain has finished.
  const failId = await queue.publish("test.fail", { n: 2 });
  const retrySecs = ((Date.now() - retryStart) / 1000).toFixed(1);

  assert.strictEqual(failAttempts, 5, `expected 5 attempts, got ${failAttempts}`);
  ok(`handler attempted 5 times (${retrySecs}s of backoff)`);

  const failed = await queue.getJob(failId);
  assert.strictEqual(failed.status, "failed", `expected failed, got ${failed.status}`);
  assert.strictEqual(failed.attempts, 5, `expected attempts=5, got ${failed.attempts}`);
  ok("job ended as status=failed with attempts=5");

  const dlq = await queue.getDLQ();
  assert.ok(
    dlq.some((j) => j.id === failId),
    "failing job never showed up in the DLQ",
  );
  ok("job is visible in getDLQ()");

  // =======================================================================
  // 5. Dashboard actions: retryJob() then deleteJob()
  // =======================================================================
  console.log("\n5. Dashboard actions (retry / delete)");

  failAttempts = 0;
  await queue.retryJob(failId);
  assert.strictEqual(failAttempts, 5, "retryJob() did not re-run the job from a clean slate");
  ok("retryJob() re-queued and re-ran the job");

  await queue.deleteJob(okId);
  assert.strictEqual(await queue.getJob(okId), null, "deleteJob() left the record behind");
  ok("deleteJob() removed the record");

  await queue.stop();

  // =======================================================================
  // 6. Crash recovery (a fresh instance picks up jobs left mid-flight)
  // =======================================================================
  console.log("\n6. Crash recovery");

  // Simulate a job that was written but never delivered — exactly what a
  // hard kill leaves behind: a row in SQLite with nobody consuming it.
  const orphan = new Queueway({ broker: "in-memory", store: "sqlite" });
  await orphan.start();
  const orphanId = await orphan.publish("test.recover", { n: 3 });
  await orphan.stop();

  const stranded = await orphan.getJob(orphanId);
  assert.strictEqual(stranded.status, "pending", "orphan job should still be pending");
  ok("job left stranded in SQLite as pending");

  const revived = new Queueway({ broker: "in-memory", store: "sqlite" });
  const recovered = [];
  revived.subscribe("test.recover", async (job) => {
    recovered.push(job.id);
  });
  await revived.start(); // start() calls recoverStuckJobs() and re-publishes
  await sleep(200);

  assert.ok(recovered.includes(orphanId), "stuck job was not recovered on restart");
  ok("recoverStuckJobs() re-queued it on the next start()");

  const revivedJob = await revived.getJob(orphanId);
  assert.strictEqual(revivedJob.status, "completed", `expected completed, got ${revivedJob.status}`);
  ok("recovered job ran to completion");

  await revived.stop();

  // =======================================================================
  console.log(
    `\n✅ BASELINE PASSED — ${passed} checks in ${((Date.now() - t0) / 1000).toFixed(1)}s. Nothing regressed.\n`,
  );
}

main()
  .then(() => cleanup(0))
  .catch((err) => {
    console.error(`\n❌ BASELINE FAILED after ${passed} passing checks`);
    console.error(`   ${err.message}\n`);
    cleanup(1);
  });

function cleanup(code) {
  for (const f of [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
  process.exit(code);
}
