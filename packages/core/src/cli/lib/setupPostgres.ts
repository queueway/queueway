import os from "os";
import { randomBytes } from "crypto";
import inquirer from "inquirer";
import { Client } from "pg";
import { dockerInstallHint, findFreePort, isPortOpen, postgresInstallHint } from "./detect";
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

export const DEFAULT_PG_PORT = 5432;

/** A password we generate ourselves, so we never have to ask for or store the user's. */
function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

async function canConnect(config: {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
}): Promise<boolean> {
  const client = new Client({ ...config, connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Tries to reach the local Postgres as a superuser without asking anyone
 * anything. This works out of the box on Homebrew (the OS user is a
 * superuser with trust auth) and on some Linux setups; on Windows the
 * installer always sets a password, so this will fail there and the wizard
 * will ask once.
 */
export async function findAdminSilently(port: number): Promise<{ user: string; password?: string } | null> {
  const candidates: Array<{ user: string; password?: string }> = [
    { user: process.env.PGUSER || os.userInfo().username },
    { user: "postgres" },
    { user: "postgres", password: "postgres" },
  ];

  for (const candidate of candidates) {
    if (await canConnect({ host: "127.0.0.1", port, database: "postgres", ...candidate })) {
      return candidate;
    }
  }
  return null;
}

/**
 * Creates Queueway's own role and database inside the user's existing
 * PostgreSQL. Nothing that already exists is dropped, altered or read — we
 * only add. Modelled on how the SQLite store creates its own file: our data
 * lives in our own place.
 */
export async function provisionInExistingPostgres(
  port: number,
  admin: { user: string; password?: string },
  slug: string,
): Promise<string> {
  const role = `queueway_${slug}`;
  const database = `queueway_${slug}`;
  const password = generatePassword();

  const client = new Client({
    host: "127.0.0.1",
    port,
    user: admin.user,
    password: admin.password,
    database: "postgres",
  });
  await client.connect();

  try {
    const existingRole = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    if (existingRole.rows.length === 0) {
      // No CREATEDB, no CREATEROLE, no SUPERUSER — this login can do nothing
      // beyond its own database.
      await client.query(
        `CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
      );
      console.log(`   ✅ Created role ${role}`);
    } else {
      await client.query(
        `ALTER ROLE ${quoteIdent(role)} WITH LOGIN PASSWORD ${quoteLiteral(password)}`,
      );
      console.log(`   ↻  Role ${role} already existed — rotated its password`);
    }

    const existingDb = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      database,
    ]);
    if (existingDb.rows.length === 0) {
      // CREATE DATABASE can't run inside a transaction block, so it goes on
      // its own.
      await client.query(
        `CREATE DATABASE ${quoteIdent(database)} OWNER ${quoteIdent(role)}`,
      );
      console.log(`   ✅ Created database ${database}`);
    } else {
      console.log(`   ↻  Database ${database} already existed — reusing it`);
    }
  } finally {
    await client.end().catch(() => {});
  }

  return `postgres://${role}:${encodeURIComponent(password)}@localhost:${port}/${database}`;
}

/** Postgres identifier quoting — these names are ours, but quote anyway. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function provisionWithDocker(slug: string): Promise<string | null> {
  // If a previous run already set this up and it still works, there is
  // nothing to do — re-running `queueway init` shouldn't rebuild anything.
  // Only reuse when OUR container is the thing actually serving that URL.
  // A working DATABASE_URL proves something is listening — it does not prove
  // it's ours. Reusing a URL that points at the machine's own PostgreSQL
  // installation would leave Queueway configured against a database Docker
  // doesn't control, so stopping the container wouldn't stop the database.
  const existingUrl = readEnvValue("QUEUEWAY_DATABASE_URL");
  const ourContainerIsUp = await containerRunning(slug, "postgres");
  if (ourContainerIsUp && existingUrl && (await urlWorks(existingUrl))) {
    console.log("   ✅ The PostgreSQL container from a previous setup is still working — reusing it.");
    // Re-declare it in the compose file so adding another service later
    // doesn't drop it and orphan the container.
    const spec = specFromUrl(existingUrl);
    if (spec) writeComposeFile([spec], slug);
    return existingUrl;
  }

  // From here on, existing job data is the thing to be careful with. The
  // volume keeps the password it was created with, and `.env` holds that same
  // password — so old data can usually be reopened rather than thrown away.
  // Whether to do that is the user's call, not ours: nothing here deletes data
  // without being told to.
  const hasVolume = await volumeExists(slug, "postgres");
  const savedSpec = existingUrl ? specFromUrl(existingUrl) : null;

  if (hasVolume) {
    const { choice } = await inquirer.prompt([
      {
        type: "list",
        name: "choice",
        message: "There's job data here from an earlier setup. What should happen to it?",
        choices: [
          { name: "Keep it — reconnect to the existing jobs", value: "keep" },
          { name: "Start fresh — delete it and create an empty database", value: "fresh" },
          { name: "Cancel", value: "cancel" },
        ],
        default: "keep",
      },
    ]);

    if (choice === "cancel") return null;

    if (choice === "keep") {
      if (!savedSpec) {
        // Postgres only applies a new password to an empty data directory, so
        // without the original there is genuinely no way in. Say so plainly
        // rather than starting a container that rejects every login.
        console.log(
          "\n   ❌ That data can't be opened: .env has no QUEUEWAY_DATABASE_URL for it, and\n" +
            "      the password is stored inside the data itself. PostgreSQL only\n" +
            "      accepts a new password on an empty database.\n" +
            "\n      If you still have the old QUEUEWAY_DATABASE_URL, put it back in .env and\n" +
            "      run `npx queueway init` again. Otherwise the only way forward is\n" +
            "      to start fresh.\n",
        );
        return null;
      }

      console.log("\n   ↻  Starting your existing data back up…\n");
      writeComposeFile([savedSpec], slug);

      if (await composeUp()) {
        process.stdout.write("\n   ⏳ Waiting for Postgres… ");
        if (await waitForPort(savedSpec.port)) {
          for (let i = 0; i < 20; i++) {
            if (await urlWorks(existingUrl!)) {
              console.log("ready.");
              console.log("   ✅ Reconnected to your existing jobs — nothing was lost.");
              return existingUrl!;
            }
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
        console.log("couldn't connect.");
      }

      console.log(
        "\n   ❌ The password in .env doesn't match this data, so it can't be opened.\n" +
          "      PostgreSQL keeps the password inside the data directory and only\n" +
          "      accepts a new one on an empty database.\n" +
          "\n      Either restore the original QUEUEWAY_DATABASE_URL to .env, or run\n" +
          "      `npx queueway init` again and choose \"Start fresh\".\n" +
          "\n      Your data has been left untouched.\n",
      );
      return null;
    }

    // Start fresh: confirm once, because this is irreversible.
    const { confirmed } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmed",
        message: "This permanently deletes those jobs. Continue?",
        default: false,
      },
    ]);
    if (!confirmed) return null;

    // Only PostgreSQL's volume — Redis/RabbitMQ data stays where it is.
    await removeVolume(slug, "postgres");
    console.log("   🗑️  Old PostgreSQL data removed.\n");
  }

  // Never assume 5432 is free — the whole point is not to fight whatever the
  // developer already runs.
  const port = await findFreePort(DEFAULT_PG_PORT);
  const user = `queueway_${slug}`.slice(0, 60);
  const database = `queueway_${slug}`.slice(0, 60);
  const password = generatePassword();

  if (port !== DEFAULT_PG_PORT) {
    console.log(
      `   ℹ️  Port ${DEFAULT_PG_PORT} is already in use, so Queueway's Postgres will use ${port} instead.`,
    );
  }

  const spec: ServiceSpec = { name: "postgres", port, user, password, database };
  const file = writeComposeFile([spec], slug);
  console.log(`   ✅ Wrote ${COMPOSE_FILE}`);
  console.log(`   🐳 Fetching the PostgreSQL image (first run only)…\n`);

  if (!(await pullImage("postgres"))) {
    console.log(
      `\n   ❌ Couldn't fetch the image. If Docker Desktop only just started, give it\n` +
        `      a moment and run \`npx queueway init\` again.\n`,
    );
    return null;
  }

  console.log(`\n   🐳 Starting the container…\n`);
  if (!(await composeUp())) {
    console.log(`\n   ❌ \`docker compose up\` failed. The file is at ${file} if you want to run it yourself.`);
    return null;
  }

  process.stdout.write("\n   ⏳ Waiting for Postgres to accept connections… ");
  if (!(await waitForPort(port))) {
    console.log("timed out.");
    return null;
  }

  const url = `postgres://${user}:${encodeURIComponent(password)}@localhost:${port}/${database}`;

  // The port opening and Postgres being ready aren't the same moment.
  let lastError = "";
  for (let i = 0; i < 20; i++) {
    const attempt = await connectWithReason({
      host: "127.0.0.1",
      port,
      user,
      password,
      database,
    });
    if (attempt.ok) {
      console.log("ready.");
      return url;
    }
    lastError = attempt.error;
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log(`failed.\n   ❌ ${lastError}`);
  return null;
}

/**
 * Rebuilds the compose service definition from a connection URL, so a
 * container we created earlier can be re-declared without recreating it.
 * Only for containers we run ourselves — a URL pointing somewhere else has
 * no compose service to describe.
 */
function specFromUrl(url: string): ServiceSpec | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host !== "localhost" && host !== "127.0.0.1") return null;
    if (!parsed.username || !parsed.password) return null;
    return {
      name: "postgres",
      port: Number(parsed.port || DEFAULT_PG_PORT),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace(/^\//, ""),
    };
  } catch {
    return null;
  }
}

async function urlWorks(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Same as canConnect, but keeps the reason — "password authentication failed"
 *  and "still starting up" are very different problems to report. */
async function connectWithReason(config: {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
}): Promise<{ ok: boolean; error: string }> {
  const client = new Client({ ...config, connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return { ok: true, error: "" };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * The full PostgreSQL path of the wizard. Returns a working DATABASE_URL, or
 * null if the user backed out — the caller then offers SQLite instead, so
 * nobody is ever left stuck.
 */
export async function setupPostgres(dockerAvailable: boolean): Promise<string | null> {
  const slug = projectSlug();
  const alreadyThere = await isPortOpen(DEFAULT_PG_PORT);

  const choices: Array<{ name: string; value: string }> = [];

  if (alreadyThere) {
    choices.push({
      name: `Use the PostgreSQL already running on port ${DEFAULT_PG_PORT} (Queueway creates its own user + database inside it)`,
      value: "existing",
    });
  }
  if (dockerAvailable) {
    choices.push({
      name: "Run a PostgreSQL container just for this project (Docker — fully automatic)",
      value: "docker",
    });
  } else {
    choices.push({
      name: "Run a PostgreSQL container (Docker isn't available right now)",
      value: "docker",
    });
  }
  choices.push({ name: "Cancel", value: "back" });

  const { how } = await inquirer.prompt([
    {
      type: "list",
      name: "how",
      message: "How should Queueway get a PostgreSQL?",
      choices,
    },
  ]);

  if (how === "back") return null;

  // ------------------------------------------------------------- existing
  if (how === "existing") {
    console.log("\n   🔍 Looking for a way in without bothering you…");
    let admin = await findAdminSilently(DEFAULT_PG_PORT);

    if (!admin) {
      console.log(
        "   Couldn't connect as an administrator on its own — that's normal on Windows.\n" +
          "   Queueway needs it once, only to create its own user and database.\n" +
          "   The password is used right here and never written anywhere.\n",
      );
      const answers = await inquirer.prompt([
        { type: "input", name: "user", message: "PostgreSQL admin user:", default: "postgres" },
        { type: "password", name: "password", message: "Password:", mask: "*" },
      ]);
      admin = { user: answers.user, password: answers.password };

      if (
        !(await canConnect({
          host: "127.0.0.1",
          port: DEFAULT_PG_PORT,
          database: "postgres",
          ...admin,
        }))
      ) {
        console.log("\n   ❌ Those credentials didn't work.\n");
        return null;
      }
    } else {
      console.log(`   ✅ Connected as "${admin.user}" — no password needed.`);
    }

    try {
      return await provisionInExistingPostgres(DEFAULT_PG_PORT, admin, slug);
    } catch (err: any) {
      console.log(`\n   ❌ Couldn't create the role/database: ${err.message}\n`);
      return null;
    }
  }

  // --------------------------------------------------------------- docker
  if (!dockerAvailable) {
    console.log("\n   Docker isn't available, so this option can't run.\n");
    console.log(dockerInstallHint());
    console.log("\n   Or install PostgreSQL directly:");
    console.log(postgresInstallHint());
    console.log("\n   Then run `npx queueway init` again.\n");
    return null;
  }

  return provisionWithDocker(slug);
}
