import fs from "fs";
import net from "net";
import path from "path";
import { execFile, spawn } from "child_process";

/**
 * Environment detection for the setup wizard.
 *
 * Everything here is deliberately read-only: it looks at what is already on
 * the machine and never installs, starts or changes anything. Deciding what
 * to do with the answers is the wizard's job, not this file's.
 */

export interface DockerStatus {
  /** `docker` is on PATH. */
  cli: boolean;
  /** The daemon is actually running — on Windows/macOS this is the usual failure. */
  daemon: boolean;
  /** Compose v2 (`docker compose`, not the old standalone `docker-compose`). */
  compose: boolean;
  version?: string;
}

function run(
  cmd: string,
  args: string[],
  timeoutMs = 8000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
      });
    });
  });
}

export async function detectDocker(): Promise<DockerStatus> {
  const version = await run("docker", ["--version"]);
  if (!version.ok) return { cli: false, daemon: false, compose: false };

  // `docker info` answers even while Docker Desktop is still booting, so it
  // isn't enough on its own — `docker image ls` touches the image store,
  // which is the subsystem that returns 500 during startup.
  const info = await run("docker", ["info", "--format", "{{.ServerVersion}}"], 15000);
  const images = info.ok ? await run("docker", ["image", "ls", "-q"], 15000) : { ok: false };
  const compose = await run("docker", ["compose", "version"]);

  return {
    cli: true,
    daemon: info.ok && images.ok,
    compose: compose.ok,
    version: version.stdout.replace(/^Docker version /, "").split(",")[0],
  };
}

/**
 * Tries to start Docker Desktop. Only meaningful on Windows/macOS, where the
 * CLI is installed system-wide but the engine only runs while the desktop app
 * is open.
 */
export async function tryStartDockerDesktop(): Promise<boolean> {
  if (process.platform === "darwin") {
    const r = await run("open", ["-a", "Docker"]);
    return r.ok;
  }

  if (process.platform === "win32") {
    // `start "" "Docker Desktop"` looks for a *file* by that name and fails
    // silently, so launch the executable directly instead.
    const candidates = [
      path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe"),
      path.join(process.env["ProgramW6432"] || "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe"),
      path.join(process.env["LOCALAPPDATA"] || "", "Docker", "Docker Desktop.exe"),
    ];

    for (const exe of candidates) {
      if (!exe || !fs.existsSync(exe)) continue;
      try {
        // Detached: Docker Desktop must outlive this CLI process.
        const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true });
        child.unref();
        return true;
      } catch {
        /* try the next path */
      }
    }
    return false;
  }

  return false; // Linux: dockerd is a system service, not ours to start.
}

export interface DockerWaitResult {
  ready: boolean;
  /** What the engine last said, so the caller can explain the failure. */
  reason?: string;
}

/**
 * Waits for Docker to be genuinely usable, reporting progress as it goes.
 *
 * Docker Desktop can fail to start for reasons no package can fix — not enough
 * memory for its VM, Hyper-V or WSL2 misconfigured, a pending Windows update.
 * When that happens the CLI keeps answering with an error rather than never
 * answering, so the useful thing is to surface that error instead of sitting
 * silently until a timeout.
 */
export async function waitForDockerDaemon(
  timeoutMs = 120_000,
  onProgress?: (secondsWaited: number) => void,
): Promise<DockerWaitResult> {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let lastReason = "";

  while (Date.now() < deadline) {
    const info = await run("docker", ["info", "--format", "{{.ServerVersion}}"], 10_000);
    if (info.ok) {
      const images = await run("docker", ["image", "ls", "-q"], 10_000);
      if (images.ok) return { ready: true };
      lastReason = images.stderr || lastReason;
    } else {
      lastReason = info.stderr || lastReason;
    }

    onProgress?.(Math.round((Date.now() - started) / 1000));
    await new Promise((r) => setTimeout(r, 3000));
  }

  return { ready: false, reason: summariseDockerError(lastReason) };
}

/** Turns Docker's raw stderr into something a person can act on. */
export function summariseDockerError(stderr: string): string {
  const text = (stderr || "").toLowerCase();

  if (text.includes("not enough memory") || text.includes("0x8007000e")) {
    return (
      "Docker's virtual machine couldn't get enough memory to start.\n" +
      "      Close some applications, or lower Docker Desktop's memory limit in\n" +
      "      Settings → Resources, then try again."
    );
  }
  if (text.includes("hyper-v") || text.includes("virtualization")) {
    return (
      "Docker couldn't start its Hyper-V virtual machine.\n" +
      "      Restarting Docker Desktop usually clears this; if it doesn't, check\n" +
      "      that virtualization is enabled in your BIOS."
    );
  }
  if (text.includes("wsl")) {
    return (
      "Docker's WSL2 backend didn't start.\n" +
      "      Try `wsl --update` in an admin terminal, then restart Docker Desktop."
    );
  }
  if (text.includes("permission denied")) {
    return (
      "Permission denied talking to the Docker socket.\n" +
      "      On Linux: sudo usermod -aG docker $USER, then log out and back in."
    );
  }
  return "Docker Desktop didn't finish starting. Its own window usually shows why.";
}

/** True if something is listening on the port — not what it is, just that it's taken. */
export function isPortOpen(port: number, host = "127.0.0.1", timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/**
 * First port from `start` that nothing is listening on. This is why the
 * wizard never collides with a Postgres/Redis the developer already runs:
 * we move, they don't.
 */
export async function findFreePort(start: number, attempts = 20): Promise<number> {
  for (let port = start; port < start + attempts; port++) {
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error(`No free port found between ${start} and ${start + attempts}`);
}

export interface ServiceProbe {
  /** Something is listening on the default port. */
  present: boolean;
  port: number;
}

export async function probeService(port: number): Promise<ServiceProbe> {
  return { present: await isPortOpen(port), port };
}

/** Copy-pasteable install instructions for whichever OS this actually is. */
export function dockerInstallHint(): string {
  if (process.platform === "win32") {
    return (
      "   Install Docker Desktop:\n" +
      "     winget install Docker.DockerDesktop\n" +
      "   or download it from https://docker.com/products/docker-desktop"
    );
  }
  if (process.platform === "darwin") {
    return (
      "   Install Docker Desktop:\n" +
      "     brew install --cask docker\n" +
      "   or download it from https://docker.com/products/docker-desktop"
    );
  }
  return (
    "   Install Docker Engine:\n" +
    "     curl -fsSL https://get.docker.com | sudo sh\n" +
    "     sudo usermod -aG docker $USER    # then log out and back in\n" +
    "   Details: https://docs.docker.com/engine/install/"
  );
}

/** Same, for a native PostgreSQL install. */
export function postgresInstallHint(): string {
  if (process.platform === "win32") {
    return "     winget install PostgreSQL.PostgreSQL.16";
  }
  if (process.platform === "darwin") {
    return "     brew install postgresql@16 && brew services start postgresql@16";
  }
  return (
    "     sudo apt install postgresql        # Debian/Ubuntu\n" +
    "     sudo dnf install postgresql-server # Fedora/RHEL\n" +
    "     sudo pacman -S postgresql          # Arch"
  );
}
