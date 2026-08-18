#!/usr/bin/env node
/**
 * Queueway — PostgreSQL Store Test (Milestone 2, Part 2)
 * ------------------------------------------------------
 * Broker stays in-memory throughout. This tests ONE thing: the Postgres
 * store. Redis/RabbitMQ come later, one at a time.
 *
 * Prereq:
 *   docker compose -f docker-compose.dev.yml up -d
 *   set DATABASE_URL=postgres://queueway:devpassword@localhost:5432/queueway
 *
 * Run:
 *   node scripts/postgres-test.js
 *
 * Destructive: it DROPs and recreates the queueway_jobs table. Never point
 * DATABASE_URL at anything real.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Load .env first so a DATABASE_URL there wins over the fallback below.
try {
  require(
    require.resolve("dotenv", {
      paths: [
        require("path").resolve(__dirname, "..", "packages", "core"),
        require("path").resolve(__dirname, ".."),
      ],
    }),
  ).config();
} catch {}

const DB_URL =
  process.env.DATABASE_URL ||
  "postgres://queueway:devpassword@localhost:5432/queueway";
process.env.DATABASE_URL = DB_URL;

const corePath = path.resolve(__dirname, "..", "packages", "core");
const { Queueway } = require(path.join(corePath, "dist", "index.js"));

// `pg` ships with queueway, but npm workspaces may hoist it to the monorepo
// root instead of packages/core — resolve from both.
const { Pool } = require(
  require.resolve("pg", { paths: [corePath, path.resolve(__dirname, "..")] }),
);

let passed = 0;
const t0 = Date.now();
const ok = (name) => {
  passed++;
  console.log(`   ✅ ${name}`);
};
const warn = (name) => console.log(`   ⚠️  ${name}`);
// Don't autoload the project's own queueway.jobs.js — these tests register
// their own handlers, and running the real ones would be both noisy and wrong.
process.env.QUEUEWAY_SKIP_JOBS_FILE = "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Short backoff: we're testing the STORE here, not the 30s backoff the
// regression baseline already locks in.
const FAST_RETRY = { maxAttempts: 3, strategy: "exponential", baseDelay: 200 };

const admin = new Pool({ connectionString: DB_URL });

async function main() {
  console.log("\n🐘 Queueway — PostgreSQL store test");
  console.log(`   ${DB_URL.replace(/:[^:@]+@/, ":****@")}\n`);

  await admin.query("DROP TABLE IF EXISTS queueway_jobs");
  await admin.query("DROP TABLE IF EXISTS queueway_workers");

  // =======================================================================
  console.log("2.1 Smoke test — schema + one job end to end");

  const queue = new Queueway({ broker: "in-memory", store: "postgres" });
  const seen = [];
  queue.subscribe("pg.test", async (job) => seen.push(job.data));
  await queue.start();

  const cols = await admin.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'queueway_jobs' ORDER BY ordinal_position`,
  );
  const colNames = cols.rows.map((r) => r.column_name);
  for (const c of ["id", "event_name", "data", "status", "attempts", "created_at", "updated_at"]) {
    assert.ok(colNames.includes(c), `column ${c} missing — got ${colNames.join(", ")}`);
  }
  assert.strictEqual(
    cols.rows.find((r) => r.column_name === "data").data_type,
    "jsonb",
    "data column is not JSONB",
  );
  ok(`table created with all 7 columns (data is JSONB)`);

  const idx = await admin.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'queueway_jobs'`,
  );
  const idxNames = idx.rows.map((r) => r.indexname);
  assert.ok(idxNames.includes("idx_status"), "idx_status missing");
  assert.ok(idxNames.includes("idx_event"), "idx_event missing");
  ok("idx_status + idx_event created");

  const payload = { hello: "postgres", nested: { n: 1, list: [1, 2, 3] } };
  const jobId = await queue.publish("pg.test", payload);
  assert.deepStrictEqual(seen[0], payload, "handler got the wrong payload");
  ok("handler ran with the payload intact");

  const stored = await queue.getJob(jobId);
  assert.strictEqual(stored.status, "completed", `expected completed, got ${stored.status}`);
  assert.deepStrictEqual(stored.data, payload, "JSONB round-trip lost data");
  assert.ok(stored.createdAt instanceof Date, "createdAt did not come back as a Date");
  ok("job persisted, status=completed, JSONB round-trip clean");

  // =======================================================================
  console.log("\n2.2 Retry + DLQ (short backoff — timing is covered by the baseline)");

  const rq = new Queueway({ broker: "in-memory", store: "postgres", retry: FAST_RETRY });
  let attempts = 0;
  const statusTrail = [];
  rq.subscribe("pg.fail", async (job) => {
    attempts++;
    const row = await admin.query("SELECT status FROM queueway_jobs WHERE id = $1", [job.id]);
    statusTrail.push(row.rows[0].status);
    throw new Error("always fails");
  });
  await rq.start();

  const failId = await rq.publish("pg.fail", { n: 2 });
  assert.strictEqual(attempts, 3, `expected 3 attempts, got ${attempts}`);
  ok("handler attempted exactly maxAttempts (3) times");

  assert.deepStrictEqual(
    statusTrail,
    ["processing", "processing", "processing"],
    `status at handler entry was ${statusTrail.join(" → ")}`,
  );
  ok("status was 'processing' on every attempt");

  const failedRow = await admin.query(
    "SELECT status, attempts FROM queueway_jobs WHERE id = $1",
    [failId],
  );
  assert.strictEqual(failedRow.rows[0].status, "failed", "did not end as failed");
  assert.strictEqual(failedRow.rows[0].attempts, 3, "attempts not persisted");
  ok("DB row: status=failed, attempts=3");

  const dlq = await rq.getDLQ();
  assert.ok(dlq.some((j) => j.id === failId), "job not in getDLQ()");
  ok("job visible in getDLQ()");

  // =======================================================================
  console.log("\n2.3 Crash recovery (single server restart)");

  const orphanId = await rq.publish("pg.orphan", { n: 3 }); // nobody subscribed
  const orphanRow = await admin.query("SELECT status FROM queueway_jobs WHERE id = $1", [orphanId]);
  assert.strictEqual(orphanRow.rows[0].status, "pending", "orphan should be pending");
  ok("job left stranded as pending");

  // The old worker has to actually be gone before the new one boots — that
  // is what a restart is. While it's still alive and heartbeating, the new
  // worker deliberately refuses to touch its jobs (see the multi-worker test).
  await rq.stop();
  await queue.stop();
  const liveWorkers = await admin.query("SELECT count(*)::int AS n FROM queueway_workers");
  assert.strictEqual(liveWorkers.rows[0].n, 0, "stopped workers did not deregister themselves");
  ok("stop() deregistered both workers from queueway_workers");

  const revived = new Queueway({ broker: "in-memory", store: "postgres", retry: FAST_RETRY });
  const recovered = [];
  revived.subscribe("pg.orphan", async (job) => recovered.push(job.id));
  await revived.start();
  await sleep(300);

  assert.ok(recovered.includes(orphanId), "recoverStuckJobs() did not re-queue it");
  ok("recovered and re-run on the next start()");

  const revivedRow = await admin.query("SELECT status FROM queueway_jobs WHERE id = $1", [orphanId]);
  assert.strictEqual(revivedRow.rows[0].status, "completed", "recovered job did not complete");
  ok("recovered job reached completed");

  // =======================================================================
  console.log("\n2.4 Stats + health against real Postgres");

  const stats = await revived.getStats();
  assert.strictEqual(typeof stats.total, "number", "stats.total broken");
  assert.ok(stats.jobs.completed >= 2, "completed count wrong");
  assert.ok(stats.jobs.failed >= 1, "failed count wrong");
  ok(`stats: ${stats.total} total, ${stats.jobs.completed} completed, ${stats.jobs.failed} failed`);

  const health = await revived.getHealth();
  assert.strictEqual(health.status, "healthy", `health is ${health.status}`);
  assert.strictEqual(health.components.database.status, "up", "database not up");
  assert.ok(typeof health.components.database.latency === "number", "no DB latency reported");
  ok(`health: database up (${health.components.database.latency}ms)`);

  await revived.deleteJob(failId);
  const gone = await admin.query("SELECT 1 FROM queueway_jobs WHERE id = $1", [failId]);
  assert.strictEqual(gone.rows.length, 0, "deleteJob() left the row behind");
  ok("deleteJob() removed the row from Postgres");

  // =======================================================================
  console.log("\n2.5 Connection handling on stop()");

  const before = await admin.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()",
  );
  await revived.stop();
  await sleep(500);
  const after = await admin.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()",
  );

  console.log(`      connections before stop(): ${before.rows[0].n}, after: ${after.rows[0].n}`);
  assert.ok(
    after.rows[0].n < before.rows[0].n,
    "stop() did not release the Postgres pool — connections stay open, which " +
      "exhausts the connection limits on managed Postgres plans",
  );
  ok("stop() closed the Postgres pool");

  const leftoverWorkers = await admin.query("SELECT count(*)::int AS n FROM queueway_workers");
  assert.strictEqual(leftoverWorkers.rows[0].n, 0, "worker row left behind after stop()");
  ok("no worker rows left behind");

  console.log(
    `\n✅ POSTGRES TESTS PASSED — ${passed} checks in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`,
  );
}

main()
  .then(async () => {
    await admin.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`\n❌ POSTGRES TEST FAILED after ${passed} passing checks`);
    console.error(`   ${err.message}\n`);
    try {
      await admin.end();
    } catch {}
    process.exit(1);
  });
