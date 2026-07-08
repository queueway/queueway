import path from "path";
import fs from "fs";
import inquirer from "inquirer";
import { spawn, ChildProcess } from "child_process";
import {
  pidFilePath,
  logFilePath,
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessAlive,
} from "../lib/daemon";

const CONFIG_FILENAMES = ["queueway.config.js", "queueway.config.cjs"];
const JOBS_FILENAMES = ["queueway.jobs.js", "queueway.jobs.cjs"];

function findFile(names: string[]): string | null {
  for (const name of names) {
    const full = path.resolve(process.cwd(), name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

const MAX_RESTARTS_PER_WINDOW = 5;
const RESTART_WINDOW_MS = 60_000;
const RESTART_DELAY_MS = 1000;

interface StartOptions {
  port?: string;
  background?: boolean;
  foreground?: boolean;
}

export async function start(options: StartOptions = {}) {
  const isDaemonChild = process.env.QUEUEWAY_DAEMON_CHILD === "1";

  if (!isDaemonChild) {
    const existing = readPidFile();
    if (existing && isProcessAlive(existing.pid)) {
      console.log(
        `⚠️  Queueway already running in the background (PID ${existing.pid}, port ${existing.port}).`,
      );
      console.log("   Run `queueway stop` first if you want to restart it.");
      return;
    }
  }

  const port = options.port ?? "4287";

  let runInBackground = Boolean(options.background);
  if (options.foreground) runInBackground = false;

  if (
    !isDaemonChild &&
    !options.background &&
    !options.foreground &&
    process.stdout.isTTY
  ) {
    const answer = await inquirer.prompt([
      {
        type: "confirm",
        name: "background",
        message: "Run in the background (frees up this terminal)?",
        default: true,
      },
    ]);
    runInBackground = answer.background;
  }

  if (runInBackground && !isDaemonChild) {
    return launchDetached(port);
  }

  runWatchdog(port, isDaemonChild);
}

function launchDetached(port: string) {
  const logFd = fs.openSync(logFilePath(), "a");
  const child = spawn(
    process.execPath,
    [process.argv[1], "start", "--port", port],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: { ...process.env, QUEUEWAY_DAEMON_CHILD: "1" },
    },
  );

  writePidFile(child.pid!, Number(port));
  child.unref();

  console.log(`🚀 Queueway started in the background (PID ${child.pid}).`);
  console.log(`   Dashboard/API: http://localhost:${port}`);
  console.log(`   Logs: ${logFilePath()}`);
  console.log(
    "   Run `queueway status` to check it, or `queueway stop` to stop it.",
  );
}

function runWatchdog(port: string, isDaemonChild: boolean) {
  const configPath = findFile(CONFIG_FILENAMES);
  const jobsPath = findFile(JOBS_FILENAMES);

  if (!configPath) {
    console.log(
      "ℹ️  No queueway.config.js found — using zero-config defaults (in-memory broker + store).",
    );
    console.log("   Run `queueway init` to create one.");
  }
  if (!jobsPath) {
    console.log(
      "ℹ️  No queueway.jobs.js found — server will run with no job handlers registered.",
    );
    console.log("   Run `queueway init` to generate a starter file.");
  }

  process.env.QUEUEWAY_CONFIG_PATH = configPath ?? "";
  process.env.QUEUEWAY_JOBS_PATH = jobsPath ?? "";
  process.env.QUEUEWAY_PORT = port;

  if (isDaemonChild) {
    writePidFile(process.pid, Number(port));
  }

  let restartCount = 0;
  let windowStart = Date.now();
  let shuttingDown = false;
  let child: ChildProcess;

  const launch = () => {
    console.log("🚀 Starting Queueway server...");
    child = spawn(
      process.execPath,
      [path.join(__dirname, "..", "server-bootstrap.js")],
      {
        stdio: "inherit",
        windowsHide: true,
      },
    );

    child.on("exit", (code, signal) => {
      if (
        shuttingDown ||
        signal === "SIGINT" ||
        signal === "SIGTERM" ||
        code === 0
      ) {
        console.log("👋 Queueway server stopped.");
        if (isDaemonChild) removePidFile();
        return;
      }

      const now = Date.now();
      if (now - windowStart > RESTART_WINDOW_MS) {
        windowStart = now;
        restartCount = 0;
      }
      restartCount += 1;

      if (restartCount > MAX_RESTARTS_PER_WINDOW) {
        console.error(
          `❌ Server crashed ${restartCount} times in the last minute — giving up auto-restart. Check the errors above.`,
        );
        if (isDaemonChild) removePidFile();
        process.exit(1);
      }

      console.warn(
        `⚠️  Server exited unexpectedly (code ${code}). Auto-restarting in ${RESTART_DELAY_MS}ms... (attempt ${restartCount}/${MAX_RESTARTS_PER_WINDOW})`,
      );
      setTimeout(launch, RESTART_DELAY_MS);
    });
  };

  const shutdown = () => {
    shuttingDown = true;
    if (child) child.kill("SIGTERM");
    if (isDaemonChild) removePidFile();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  launch();
}
