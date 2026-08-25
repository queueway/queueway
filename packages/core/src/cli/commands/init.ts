import fs from "fs";
import inquirer from "inquirer";
import { logger } from "../../logging/Logger";
import {
  detectDocker,
  DockerStatus,
  tryStartDockerDesktop,
  waitForDockerDaemon,
} from "../lib/detect";
import { ensureEnvIgnored, projectSlug, upsertEnv } from "../lib/envFile";
import { setupPostgres } from "../lib/setupPostgres";
import { setupBroker } from "../lib/setupBroker";

const JOBS_TEMPLATE = `// queueway.jobs.js
// Define your job handlers here. This file is auto-loaded by \`queueway start\`.
module.exports = function registerJobs(queue) {
  // Example:
  // queue.subscribe('email.send', async (job) => {
  //   console.log('Sending email:', job.data);
  // });
};
`;

const BROKER_CHOICES = [
  {
    name: "In-Memory — single process, zero setup (recommended to start)",
    value: "in-memory",
  },
  {
    name: "Redis — run several workers across processes/servers",
    value: "redis",
  },
];

/**
 * The store list depends on the broker, and not for cosmetic reasons.
 *
 * Redis and RabbitMQ exist to run several workers at once. Several workers
 * need a store they can all reach — and SQLite is a local file, so two
 * servers can't share it, while In-Memory isn't shared even between two
 * processes on the same machine. Offering them here would produce a setup
 * that looks fine and silently loses or duplicates jobs, so PostgreSQL is
 * the only honest option.
 */
function storeChoicesFor(broker: string) {
  if (broker === "redis" || broker === "rabbitmq") {
    return [
      {
        name: "PostgreSQL — shared by every worker (required for multi-worker)",
        value: "postgres",
      },
    ];
  }
  return [
    {
      name: "SQLite — a file on disk, survives restarts (recommended)",
      value: "sqlite",
    },
    {
      name: "PostgreSQL — a real database, ready to grow into multi-worker later",
      value: "postgres",
    },
  ];
}

async function resolveDocker(): Promise<DockerStatus> {
  const docker = await detectDocker();

  if (docker.cli && !docker.daemon) {
    // On Linux the engine is a system service, not an app we can launch —
    // starting it needs root, which an npm package should never take.
    if (process.platform === "linux") {
      console.log(
        "\n   ℹ️  Docker is installed but its service isn't running. Start it with:\n" +
          "        sudo systemctl start docker\n" +
          "      then run `npx queueway init` again.\n",
      );
      return docker;
    }

    // By far the most common state on Windows and macOS: installed, not running.
    const { start } = await inquirer.prompt([
      {
        type: "confirm",
        name: "start",
        message: "Docker is installed but not running. Start Docker Desktop now?",
        default: true,
      },
    ]);
    if (!start) return docker;

    if (!(await tryStartDockerDesktop())) {
      console.log(
        "\n   ⚠️  Couldn't launch Docker Desktop. Start it yourself and run\n" +
          "      `npx queueway init` again.\n",
      );
      return docker;
    }

    // Show the wait rather than freezing: Docker Desktop can take a minute on a
    // good day, and can fail outright on a bad one.
    process.stdout.write("   ⏳ Waiting for Docker to start… ");
    let dots = 0;
    const result = await waitForDockerDaemon(120_000, (seconds) => {
      if (seconds >= dots * 15 + 15) {
        dots++;
        process.stdout.write(`${seconds}s… `);
      }
    });

    if (result.ready) {
      console.log("ready.");
      return { ...docker, daemon: true };
    }

    console.log("gave up.\n");
    console.log(`   ⚠️  ${result.reason}\n`);
    console.log("      Queueway can carry on without Docker — pick another option below.\n");
  }

  return docker;
}

export async function init() {
  // A wizard that asks questions can only run where someone can answer them.
  // In CI or a Docker build there's nobody there, and silently guessing a
  // database would be worse than stopping.
  if (!process.stdin.isTTY) {
    console.error(
      "❌ `queueway init` is interactive and this isn't an interactive terminal.\n" +
        "   For automated environments, set the config yourself:\n" +
        "     DATABASE_URL / REDIS_URL / RABBITMQ_URL in the environment,\n" +
        "     plus a queueway.config.js with your broker and store.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\n🚀 Queueway setup\n");

  const { broker } = await inquirer.prompt([
    {
      type: "list",
      name: "broker",
      message: "Choose a broker (how jobs get delivered to your handlers):",
      choices: BROKER_CHOICES,
    },
  ]);

  const storeChoices = storeChoicesFor(broker);
  let store: string;

  if (storeChoices.length === 1) {
    store = storeChoices[0].value;
    console.log(
      `\n   ℹ️  Store: PostgreSQL. Every worker has to read the same job records,\n` +
        `      and SQLite is a local file — two workers can't share one.\n`,
    );
  } else {
    const answer = await inquirer.prompt([
      {
        type: "list",
        name: "store",
        message: "Choose a store (where job records are saved):",
        choices: storeChoices,
      },
    ]);
    store = answer.store;
  }

  const needsDocker = store === "postgres" || broker === "redis" || broker === "rabbitmq";
  const docker = needsDocker ? await resolveDocker() : { cli: false, daemon: false, compose: false };
  const dockerReady = docker.daemon && docker.compose;

  const env: Record<string, string> = {};
  let finalBroker: string = broker;

  // ---------------------------------------------------------------- store
  if (store === "postgres") {
    console.log("\n📦 PostgreSQL\n");
    const url = await setupPostgres(dockerReady);

    if (url) {
      env.QUEUEWAY_DATABASE_URL = url;
    } else {
      // Don't quietly rewrite what the user asked for. Setting up PostgreSQL
      // failed; ask what to do instead of downgrading their choices behind
      // their back.
      const { next } = await inquirer.prompt([
        {
          type: "list",
          name: "next",
          message: "PostgreSQL wasn't set up. What now?",
          choices: [
            { name: "Try again", value: "retry" },
            {
              name: "Use SQLite instead (needs nothing installed, single worker only)",
              value: "sqlite",
            },
            { name: "Quit and change nothing", value: "quit" },
          ],
        },
      ]);

      if (next === "quit") {
        console.log("\n   Nothing was written.\n");
        return;
      }

      if (next === "retry") {
        const retried = await setupPostgres(dockerReady);
        if (retried) {
          env.QUEUEWAY_DATABASE_URL = retried;
        } else {
          console.log("\n   Still no PostgreSQL. Nothing was written.\n");
          return;
        }
      } else {
        store = "sqlite";
        if (broker !== "in-memory") {
          console.log(
            `\n   ⚠️  ${broker} needs a store every worker can reach, and SQLite is a\n` +
              `      local file. The broker is going back to in-memory so the\n` +
              `      configuration stays honest.\n`,
          );
          finalBroker = "in-memory";
        }
      }
    }
  }

  // --------------------------------------------------------------- broker
  if (finalBroker === "redis" || finalBroker === "rabbitmq") {
    console.log(`\n📦 ${finalBroker === "redis" ? "Redis" : "RabbitMQ"}\n`);
    const url = await setupBroker(finalBroker, dockerReady);
    if (!url) {
      console.log("\n   Broker setup was cancelled — nothing was written.\n");
      process.exitCode = 1;
      return;
    }
    env[finalBroker === "redis" ? "QUEUEWAY_REDIS_URL" : "QUEUEWAY_RABBITMQ_URL"] = url;
  }

  // ------------------------------------------------------------- write it
  if (Object.keys(env).length > 0) {
    const result = upsertEnv(env);
    const changed = [...result.added, ...result.updated];
    console.log(
      changed.length > 0
        ? `\n✅ Wrote ${changed.join(", ")} to .env`
        : `\n✅ .env was already correct — nothing to change`,
    );

    const ignored = ensureEnvIgnored();
    if (ignored === "added") console.log("✅ Added .env to .gitignore (it holds a password)");
    else if (ignored === "no-git") console.log("ℹ️  No git repo here — remember .env holds a password");
  }

  const config = `module.exports = {
  broker: '${finalBroker}',
  store: '${store}',
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

  console.log(`\n   Project: ${projectSlug()}   Broker: ${finalBroker}   Store: ${store}`);
  console.log("\nNext: run `npx queueway start` to boot the server + dashboard.\n");
}
