import inquirer from "inquirer";
import fs from "fs";

/**
 * Only production-tested broker/store options are offered here. As each
 * new one (Redis, RabbitMQ, PostgreSQL, ...) finishes its own dev+prod
 * testing pass, add it to these lists — never before.
 */
const TESTED_STORES = [
  {
    name: "SQLite (recommended — persists to disk, survives crashes/restarts)",
    value: "sqlite",
  },
  {
    name: "In-Memory (testing only — data lost on restart)",
    value: "in-memory",
  },
];

const TESTED_BROKERS = [
  {
    name: "In-Memory (single-process — more brokers coming soon: Redis, RabbitMQ)",
    value: "in-memory",
  },
];

const JOBS_TEMPLATE = `// queueway.jobs.js
// Define your job handlers here. This file is auto-loaded by \`queueway start\`.
module.exports = function registerJobs(queue) {
  // Example:
  // queue.subscribe('email.send', async (job) => {
  //   console.log('Sending email:', job.data);
  // });
};
`;

export async function init() {
  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "store",
      message: "Choose a store (only production-tested options are shown):",
      choices: TESTED_STORES,
    },
    {
      type: "list",
      name: "broker",
      message: "Choose a broker (only production-tested options are shown):",
      choices: TESTED_BROKERS,
    },
  ]);

  const config = `module.exports = {
  broker: '${answers.broker}',
  store: '${answers.store}',
  retry: {
    maxAttempts: 5,
    strategy: 'exponential',
  },
};
`;

  fs.writeFileSync("queueway.config.js", config);
  console.log("✅ Config created: queueway.config.js");

  if (!fs.existsSync("queueway.jobs.js")) {
    fs.writeFileSync("queueway.jobs.js", JOBS_TEMPLATE);
    console.log("✅ Starter jobs file created: queueway.jobs.js");
  }

  console.log("");
  console.log("Next: run `npx queueway start` to boot the server + dashboard.");
}
