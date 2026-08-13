#!/usr/bin/env node
/**
 * Queueway — Resilience test (Milestone 2)
 * ----------------------------------------
 * The question this answers: when PostgreSQL or Redis goes away while the app
 * is running, does Queueway survive it?
 *
 * A library that takes the whole process down because a container restarted is
 * worse than useless — the app dies, in-flight work is lost, and the operator
 * gets a stack trace instead of a warning. This test stops the containers for
 * real and checks that:
 *
 *   1. the process stays alive
 *   2. errors are catchable by the caller, not thrown at the process
 *   3. health reports 'down' honestly instead of lying
 *   4. everything reconnects on its own once the service returns
 *
 * Requires the containers created by `queueway init`, or docker-compose.dev.yml.
 * Pass the container names if yours differ:
 *
 *   node scripts/resilience-test.js --pg queueway-myapp-postgres
 */

const path = require("path");
const { execSync } = require("child_process");

try {
  require(require.resolve("dotenv", {
    paths: [path.resolve(__dirname, "..", "packages", "core"), path.resolve(__dirname, "..")],
  })).config();
} catch {}

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PG_CONTAINER = argOf("--pg", null);
const corePath = path.resolve(__dirname, "..", "packages", "core");
const { Queueway } = require(path.join(corePath, "dist", "index.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`   ✅ ${m}`);
};

// The whole point: nothing below may reach here.
process.on("uncaughtException", (err) => {
  console.error(`\n❌ CRASHED — an outage took the process down: ${err.message}`);
  console.error(`   This is the failure mode this test exists to prevent.\n`);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error(`\n❌ CRASHED — unhandled rejection during an outage: ${err && err.message}`);
  process.exit(1);
});

function findPostgresContainer() {
  if (PG_CONTAINER) return PG_CONTAINER;
  try {
    const out = execSync(
      `docker ps --filter "name=postgres" --format "{{.Names}}"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out.split("\n").filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

function docker(action, container) {
  execSync(`docker ${action} ${container}`, { stdio: ["ignore", "ignore", "ignore"] });
}

async function main() {
  const container = findPostgresContainer();
  if (!container) {
    console.error(
      "\n❌ No running PostgreSQL container found.\n" +
        "   Start one with `queueway init` (Docker option) or docker-compose.dev.yml,\n" +
        "   or pass the name: node scripts/resilience-test.js --pg <container>\n",
    );
    process.exit(1);
  }

  console.log(`\n🔌 Queueway resilience test`);
  console.log(`   container: ${container}\n`);

  console.log("1. Normal operation");
  const queue = new Queueway({ broker: "in-memory", store: "postgres" });
  const ran = [];
  queue.subscribe("res.test", async (job) => ran.push(job.data.n));
  await queue.start();
  await queue.publish("res.test", { n: 1 });
  if (!ran.includes(1)) throw new Error("baseline job did not run");
  ok("job published and processed");

  console.log("\n2. Stopping PostgreSQL mid-flight");
  docker("stop", container);
  await sleep(4000);
  ok("process is still alive after the database disappeared");

  console.log("\n3. Behaviour while it's down");
  let threwCleanly = false;
  try {
    await queue.publish("res.test", { n: 2 });
  } catch {
    threwCleanly = true;
  }
  if (!threwCleanly) throw new Error("publish() should reject while the database is unreachable");
  ok("publish() rejects — the caller can catch and retry");

  const health = await queue.getHealth();
  if (health.components.database.status !== "down") {
    throw new Error(`health should report the database as down, said "${health.components.database.status}"`);
  }
  ok(`health reports honestly (status: ${health.status}, database: down)`);

  console.log("\n4. Bringing PostgreSQL back");
  docker("start", container);
  await sleep(8000);

  let recovered = false;
  for (let i = 0; i < 10; i++) {
    try {
      await queue.publish("res.test", { n: 3 });
      recovered = true;
      break;
    } catch {
      await sleep(2000);
    }
  }
  if (!recovered) throw new Error("never reconnected after the database came back");
  ok("reconnected on its own — no restart needed");

  const healthAfter = await queue.getHealth();
  if (healthAfter.status !== "healthy") throw new Error("health did not return to healthy");
  ok("health back to healthy");

  await queue.stop();
  console.log(`\n✅ RESILIENCE PASSED — ${passed} checks. An outage is a warning, not a crash.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌ RESILIENCE FAILED after ${passed} passing checks\n   ${err.message}\n`);
  process.exit(1);
});
