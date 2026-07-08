import fs from "fs";
import path from "path";

const RUN_DIR = ".queueway";

function ensureRunDir(): string {
  const dir = path.resolve(process.cwd(), RUN_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function pidFilePath(): string {
  return path.join(ensureRunDir(), "server.pid");
}

export function logFilePath(): string {
  return path.join(ensureRunDir(), "server.log");
}

export function writePidFile(pid: number, port: number): void {
  fs.writeFileSync(
    pidFilePath(),
    JSON.stringify({ pid, port, startedAt: new Date().toISOString() }),
  );
}

export interface PidFileInfo {
  pid: number;
  port: number;
  startedAt: string;
}

export function readPidFile(): PidFileInfo | null {
  try {
    const raw = fs.readFileSync(pidFilePath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function removePidFile(): void {
  try {
    fs.unlinkSync(pidFilePath());
  } catch {
    /* already gone */
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
