import { readPidFile, isProcessAlive } from "../lib/daemon";

export async function status(options: { port?: string } = {}) {
  const pidInfo = readPidFile();
  const port = options.port ?? String(pidInfo?.port ?? 4287);
  const url = `http://localhost:${port}`;

  let reachable = false;
  let healthData: any = null;
  try {
    healthData = await fetch(`${url}/queueway/health`).then((r) => r.json());
    reachable = true;
  } catch {
    reachable = false;
  }

  if (reachable) {
    console.log(`✅ Queueway is RUNNING — ${url}`);
    console.log(`   Status: ${healthData.status}`);
    if (pidInfo && isProcessAlive(pidInfo.pid)) {
      console.log(
        `   Mode: background (PID ${pidInfo.pid}, started ${pidInfo.startedAt})`,
      );
    } else {
      console.log("   Mode: foreground (or started outside this CLI)");
    }
  } else {
    console.log(`❌ Queueway is NOT reachable at ${url}`);
    if (pidInfo) {
      const alive = isProcessAlive(pidInfo.pid);
      console.log(
        alive
          ? `   ⚠️  A background process (PID ${pidInfo.pid}) is still running but isn't responding — it may be stuck.`
          : `   Stale pidfile found (PID ${pidInfo.pid} is no longer running) — safe to ignore or run \`queueway stop\`.`,
      );
    } else {
      console.log(
        "   No background server found either. Run `queueway start` to start one.",
      );
    }
  }
}
