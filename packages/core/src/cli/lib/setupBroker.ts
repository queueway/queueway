import { randomBytes } from "crypto";
import inquirer from "inquirer";
import { dockerInstallHint, findFreePort, isPortOpen } from "./detect";
import { projectSlug, readEnvValue } from "./envFile";
import {
  COMPOSE_FILE,
  composeUp,
  containerRunning,
  pullImage,
  removeVolume,
  ServiceSpec,
  volumeExists,
  waitForPort,
  writeComposeFile,
} from "./dockerServices";

export const DEFAULT_REDIS_PORT = 6379;
export const DEFAULT_RABBIT_PORT = 5672;
export const DEFAULT_RABBIT_UI_PORT = 15672;

export type BrokerService = "redis" | "rabbitmq";

const LABEL: Record<BrokerService, string> = {
  redis: "Redis",
  rabbitmq: "RabbitMQ",
};

function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

async function provisionWithDocker(service: BrokerService): Promise<string | null> {
  const slug = projectSlug();

  // RabbitMQ bakes its credentials into its volume the same way Postgres does,
  // so a leftover volume plus a freshly generated password means every login
  // fails. Redis has no auth, so its old volume is harmless — reusing it just
  // keeps previously queued jobs.
  if (service === "rabbitmq" && (await volumeExists(slug, "rabbitmq"))) {
    const previous = readEnvValue("RABBITMQ_URL");

    if (previous && (await containerRunning(slug, "rabbitmq"))) {
      console.log("   ✅ Reusing the RabbitMQ container from a previous setup.");
      return previous;
    }

    const { choice } = await inquirer.prompt([
      {
        type: "list",
        name: "choice",
        message: "There's RabbitMQ data from an earlier setup. What should happen to it?",
        choices: [
          { name: "Keep it — reconnect to the existing queues", value: "keep" },
          { name: "Start fresh — delete it", value: "fresh" },
          { name: "Cancel", value: "cancel" },
        ],
        default: "keep",
      },
    ]);

    if (choice === "cancel") return null;

    if (choice === "keep") {
      if (previous) return previous;
      console.log(
        "\n   ❌ That data can't be opened: .env has no RABBITMQ_URL for it, and the\n" +
          "      credentials are stored inside the data itself.\n" +
          "      Restore the old RABBITMQ_URL to .env, or start fresh.\n",
      );
      return null;
    }

    const { confirmed } = await inquirer.prompt([
      { type: "confirm", name: "confirmed", message: "This permanently deletes those queues. Continue?", default: false },
    ]);
    if (!confirmed) return null;
    await removeVolume(slug, "rabbitmq");
    console.log("   🗑️  Old RabbitMQ data removed.\n");
  }

  const defaultPort = service === "redis" ? DEFAULT_REDIS_PORT : DEFAULT_RABBIT_PORT;
  const port = await findFreePort(defaultPort);

  if (port !== defaultPort) {
    console.log(
      `   ℹ️  Port ${defaultPort} is taken, so Queueway's ${LABEL[service]} will use ${port} instead.`,
    );
  }

  let spec: ServiceSpec;
  let url: string;

  if (service === "redis") {
    spec = { name: "redis", port };
    url = `redis://localhost:${port}`;
  } else {
    const uiPort = await findFreePort(DEFAULT_RABBIT_UI_PORT);
    const user = `queueway_${slug}`.slice(0, 60);
    const password = generatePassword();
    spec = { name: "rabbitmq", port, extraPort: uiPort, user, password };
    url = `amqp://${user}:${encodeURIComponent(password)}@localhost:${port}`;
    console.log(`   ℹ️  Management UI will be at http://localhost:${uiPort} (user: ${user})`);
  }

  writeComposeFile([spec], slug);
  console.log(`   ✅ Wrote ${COMPOSE_FILE}`);
  console.log(`   🐳 Fetching the ${LABEL[service]} image (first run only)…\n`);

  if (!(await pullImage(service))) {
    console.log(
      `\n   ❌ Couldn't fetch the image. If Docker Desktop only just started, give it\n` +
        `      a moment and run \`npx queueway init\` again.\n`,
    );
    return null;
  }

  console.log(`\n   🐳 Starting the container…\n`);
  if (!(await composeUp())) {
    console.log(`\n   ❌ \`docker compose up\` failed.`);
    return null;
  }

  process.stdout.write(`\n   ⏳ Waiting for ${LABEL[service]}… `);
  // RabbitMQ takes noticeably longer than Redis to finish booting.
  const ok = await waitForPort(port, service === "rabbitmq" ? 150_000 : 60_000);
  console.log(ok ? "ready." : "timed out.");
  return ok ? url : null;
}

/**
 * Gets a working broker URL. Same shape as the Postgres flow: use what's
 * already running, or start our own container, or take a URL — and always
 * allow backing out rather than dead-ending.
 */
export async function setupBroker(
  service: BrokerService,
  dockerAvailable: boolean,
): Promise<string | null> {
  const defaultPort = service === "redis" ? DEFAULT_REDIS_PORT : DEFAULT_RABBIT_PORT;
  const alreadyThere = await isPortOpen(defaultPort);

  const choices: Array<{ name: string; value: string }> = [];
  if (alreadyThere) {
    choices.push({
      name: `Use the ${LABEL[service]} already running on port ${defaultPort}`,
      value: "existing",
    });
  }
  choices.push({
    name: dockerAvailable
      ? `Run a ${LABEL[service]} container for this project (Docker — fully automatic)`
      : `Run a ${LABEL[service]} container (Docker isn't available right now)`,
    value: "docker",
  });
  choices.push({ name: "Cancel", value: "back" });

  const { how } = await inquirer.prompt([
    {
      type: "list",
      name: "how",
      message: `How should Queueway reach ${LABEL[service]}?`,
      choices,
    },
  ]);

  if (how === "back") return null;

  if (how === "existing") {
    // Redis needs no credentials by default; RabbitMQ accepts guest/guest on
    // localhost only. Both are fine for local development, and a URL can be
    // pasted instead when they aren't.
    return service === "redis"
      ? `redis://localhost:${defaultPort}`
      : `amqp://localhost:${defaultPort}`;
  }

  if (!dockerAvailable) {
    console.log("\n   Docker isn't available, so this option can't run.\n");
    console.log(dockerInstallHint());
    console.log("\n   Then run `npx queueway init` again.\n");
    return null;
  }

  return provisionWithDocker(service);
}
