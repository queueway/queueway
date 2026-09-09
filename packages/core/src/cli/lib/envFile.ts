import fs from "fs";
import path from "path";

const ENV_PATH = () => path.resolve(process.cwd(), ".env");
const GITIGNORE_PATH = () => path.resolve(process.cwd(), ".gitignore");

/**
 * Adds or updates keys in `.env` without disturbing anything already there —
 * comments, ordering and unrelated keys are all preserved. A setup wizard
 * that flattens someone's existing .env would be worse than no wizard.
 */
/**
 * Every variable Queueway writes carries this prefix. `DATABASE_URL` and
 * `REDIS_URL` are among the most common names in Node projects and almost
 * always belong to the application itself — overwriting one would repoint the
 * app's own database at the job queue.
 */
const OWNED_PREFIX = "QUEUEWAY_";

export function upsertEnv(vars: Record<string, string>): { path: string; added: string[]; updated: string[] } {
  for (const key of Object.keys(vars)) {
    if (!key.startsWith(OWNED_PREFIX)) {
      // A guard, not a formality: this is what stops a future change from
      // quietly clobbering someone's configuration.
      throw new Error(
        `Refusing to write "${key}" to .env — Queueway only writes ${OWNED_PREFIX}* variables.`,
      );
    }
  }

  const file = ENV_PATH();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = existing.length ? existing.split(/\r?\n/) : [];

  const added: string[] = [];
  const updated: string[] = [];

  for (const [key, value] of Object.entries(vars)) {
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    const line = `${key}=${value}`;
    if (idx >= 0) {
      if (lines[idx] !== line) updated.push(key);
      lines[idx] = line;
    } else {
      lines.push(line);
      added.push(key);
    }
  }

  const output = lines.join("\n").replace(/\n{3,}$/, "\n\n").replace(/\s*$/, "\n");
  fs.writeFileSync(file, output, "utf8");
  return { path: file, added, updated };
}

/**
 * Makes sure `.env` is gitignored. The wizard writes a database password into
 * it, so this is not a nicety — an un-ignored .env is how credentials end up
 * in a public repo.
 */
export function ensureEnvIgnored(): "already" | "added" | "no-git" {
  const gitDir = path.resolve(process.cwd(), ".git");
  const file = GITIGNORE_PATH();

  if (!fs.existsSync(gitDir) && !fs.existsSync(file)) return "no-git";

  const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const ignored = content
    .split(/\r?\n/)
    .some((l) => l.trim() === ".env" || l.trim() === ".env*" || l.trim() === "*.env");

  if (ignored) return "already";

  const addition = `${content && !content.endsWith("\n") ? "\n" : ""}\n# Queueway writes database credentials here\n.env\n`;
  fs.writeFileSync(file, content + addition, "utf8");
  return "added";
}

/** Reads a single key out of the project's .env, if it exists. */
export function readEnvValue(key: string): string | undefined {
  const file = ENV_PATH();
  if (!fs.existsSync(file)) return undefined;
  const match = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (!match) return undefined;
  return match.slice(match.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
}

/**
 * A stable, filesystem- and Postgres-safe name for this project, used for the
 * dedicated role/database/volume. Per-project rather than a shared "queueway"
 * so two projects on one machine never end up sharing a jobs table — which
 * would mean each one's dashboard showing the other's jobs.
 */
export function projectSlug(): string {
  let name = path.basename(process.cwd());
  try {
    const pkgPath = path.resolve(process.cwd(), "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.name) name = String(pkg.name).replace(/^@[^/]+\//, "");
    }
  } catch {
    /* fall back to the folder name */
  }

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

  // Postgres identifiers can't start with a digit.
  return /^[0-9]/.test(slug) ? `p${slug}` : slug || "app";
}
