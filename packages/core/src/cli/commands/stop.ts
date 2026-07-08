import { readPidFile, removePidFile, isProcessAlive } from "../lib/daemon";

export async function stop() {
  const pidInfo = readPidFile();

  if (!pidInfo) {
    console.log("ℹ️  No background Queueway server found.");
    console.log(
      "   If it's running in the foreground, just press Ctrl+C in its terminal.",
    );
    return;
  }

  if (!isProcessAlive(pidInfo.pid)) {
    console.log(
      "ℹ️  pidfile found but that process is no longer running — cleaning up.",
    );
    removePidFile();
    return;
  }

  process.kill(pidInfo.pid, "SIGTERM");
  console.log(`🛑 Stop signal sent to PID ${pidInfo.pid}...`);

  await new Promise((resolve) => setTimeout(resolve, 2000));

  if (isProcessAlive(pidInfo.pid)) {
    console.log(
      "⚠️  Still running — it may need another moment, or try again.",
    );
  } else {
    removePidFile();
    console.log("✅ Queueway server stopped.");
  }
}
