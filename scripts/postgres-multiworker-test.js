#!/usr/bin/env node
/**
 * Queueway — Multi-worker duplicate check (Milestone 2, Part 2.4)
 * ---------------------------------------------------------------
 * The single most important test in Milestone 2. A job running twice means
 * two invoices, two emails, two payments — worse than a job crashing.
 *
 * Two workers share ONE Postgres store (the whole point of Postgres: SQLite
 * can't be shared). Worker A is mid-job. Worker B boots. Does B steal and
 * re-run A's in-flight job?
 *
 * Run:
 *   node scripts/postgres-multiworker-test.js
 *
 * Exit 0 = no duplicates. Exit 1 = duplicates confirmed.
 * Destructive: DROPs queueway_jobs.
 */

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
const { Pool } = require(
  require.resolve("pg", { paths: [corePath, path.resolve(__dirname, "..")] }),
);

// Don't autoload the project's own queueway.jobs.js — these tests register
// their own handlers, and running the real ones would be both noisy and wrong.
process.env.QUEUEWAY_SKIP_JOBS_FILE = "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = new Pool({ connectionString: DB_URL });

// Who ran which job, and how many times.
const executions = [];

function makeWorker(name) {
  const q = new Queueway({ broker: "in-memory", store: "postgres" });
  q.subscribe("mw.slow", async (job) => {
    executions.push({ worker: name, jobId: job.id });
    console.log(`   [${name}] started job ${job.id.slice(0, 8)}`);
    await sleep(3000); // long enough that it's clearly still in flight
    console.log(`   [${name}] finished job ${job.id.slice(0, 8)}`);
  });
  return q;
}

async function main() {
  console.log("\n👥 Queueway — multi-worker duplicate check (shared Postgres)\n");
  await admin.query("DROP TABLE IF EXISTS queueway_jobs");
  await admin.query("DROP TABLE IF EXISTS queueway_workers");

  // =======================================================================
  // Scenario 1 — a LIVE worker's in-flight job must not be stolen
  // =======================================================================
  console.log("Scenario 1: Worker B boots while Worker A is mid-job\n");

  const workerA = makeWorker("A");
  await workerA.start();

  console.log("→ Worker A publishes a 3s job and starts processing it");
  const jobPromise = workerA.publish("mw.slow", { n: 1 });
  await sleep(500); // A is now mid-handler

  const midFlight = await admin.query(
    "SELECT id, status, worker_id FROM queueway_jobs",
  );
  console.log(
    `   DB right now: ${midFlight.rows
      .map((r) => `${r.id.slice(0, 8)}=${r.status} owner=${(r.worker_id || "none").slice(0, 8)}`)
      .join(", ")}\n`,
  );

  console.log("→ Worker B boots (a deploy, a restart, a second server…)");
  const workerB = makeWorker("B");
  await workerB.start(); // start() runs recoverStuckJobs()
  await sleep(500);

  await jobPromise;
  await sleep(3500); // let anything B picked up finish too

  const byJob = {};
  for (const e of executions) {
    byJob[e.jobId] = byJob[e.jobId] || [];
    byJob[e.jobId].push(e.worker);
  }

  let duplicates = 0;
  console.log("\n─────────────────────────────────────────────");
  for (const [jobId, workers] of Object.entries(byJob)) {
    const line = `job ${jobId.slice(0, 8)} ran ${workers.length}× (${workers.join(", ")})`;
    if (workers.length > 1) {
      duplicates++;
      console.log(`❌ ${line}`);
    } else {
      console.log(`✅ ${line}`);
    }
  }

  // =======================================================================
  // Scenario 2 — a DEAD worker's job must still be reclaimed
  // =======================================================================
  console.log("\nScenario 2: a worker died mid-job — nobody should lose it\n");

  // A worker that crashed hard: its job row still says 'processing' and
  // points at a worker_id that never deregistered and stopped heartbeating.
  const deadJobId = "00000000-dead-dead-dead-000000000001";
  await admin.query(
    `INSERT INTO queueway_jobs (id, event_name, data, status, attempts, worker_id, locked_at)
     VALUES ($1, 'mw.slow', '{"n":99}'::jsonb, 'processing', 0, 'worker-that-crashed', NOW() - interval '10 minutes')`,
    [deadJobId],
  );
  console.log("→ Left a 'processing' job owned by a worker that never came back");

  const workerC = makeWorker("C");
  await workerC.start();
  await sleep(4000); // let it run the reclaimed job

  const reclaimed = executions.filter((e) => e.jobId === deadJobId);
  const deadRow = await admin.query("SELECT status FROM queueway_jobs WHERE id = $1", [deadJobId]);

  console.log("\n─────────────────────────────────────────────");
  let orphanLost = false;
  if (reclaimed.length === 1 && deadRow.rows[0].status === "completed") {
    console.log(`✅ dead worker's job reclaimed and completed by ${reclaimed[0].worker}`);
  } else if (reclaimed.length === 0) {
    orphanLost = true;
    console.log(`❌ dead worker's job was never reclaimed — it is lost (status=${deadRow.rows[0].status})`);
  } else {
    duplicates++;
    console.log(`❌ dead worker's job ran ${reclaimed.length}×`);
  }

  await workerA.stop();
  await workerB.stop();
  await workerC.stop();
  await admin.end();

  if (duplicates > 0) {
    console.log(
      `\n❌ DUPLICATES CONFIRMED — ${duplicates} job(s) ran more than once.\n` +
        `   A job running twice means two invoices, two emails, two payments.\n` +
        `   Do not move on to Redis until this is zero.\n`,
    );
    process.exit(1);
  }
  if (orphanLost) {
    console.log(
      `\n❌ A crashed worker's job was never picked up — recovery is too` +
        ` conservative.\n`,
    );
    process.exit(1);
  }

  console.log(
    "\n✅ No duplicates, and no orphans lost — safe to move on to the Redis broker.\n",
  );
  process.exit(0);
}

main().catch(async (err) => {
  console.error(`\n💥 Test errored: ${err.message}\n`);
  try {
    await admin.end();
  } catch {}
  process.exit(1);
});
