/**
 * Runs inside a forked child process (see commands/start.ts). Kept separate
 * from the parent CLI process so that if THIS crashes, the parent can
 * detect the exit and automatically restart it (auto-heal).
 */

async function main() {
  const { Queueway, startServer } = require("../index");

  const configPath = process.env.QUEUEWAY_CONFIG_PATH;
  const jobsPath = process.env.QUEUEWAY_JOBS_PATH;
  const port = Number(process.env.QUEUEWAY_PORT || 4287);

  const config = configPath
    ? require(configPath)
    : { broker: "in-memory", store: "in-memory" };

  const queue = new Queueway(config);

  if (jobsPath) {
    const registerJobs = require(jobsPath);
    const register =
      typeof registerJobs === "function" ? registerJobs : registerJobs?.default;
    if (typeof register === "function") {
      register(queue);
    } else {
      console.warn(
        `⚠️  ${jobsPath} was found but doesn't export a function — no job handlers registered.`,
      );
    }
  }

  await queue.start();
  startServer(queue, port);

  console.log(
    `✅ Queueway running — dashboard/API at http://localhost:${port}`,
  );
}

main().catch((err) => {
  console.error("❌ Queueway server crashed during startup:", err);
  process.exit(1); // non-zero exit tells the parent process to auto-restart
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("❌ Unhandled rejection:", err);
  process.exit(1);
});
