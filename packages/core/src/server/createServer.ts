import path from "path";
import express, { Express, Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import type { Queueway } from "../Queueway";
import { logger } from "../logging/Logger";
import { AuthStore } from "../auth/AuthStore";
import { registerAuthRoutes, requireAuth } from "../auth/authRoutes";
import { getLocalNetworkIPs, getPublicIP } from "./networkInfo";

/** Wraps an async route handler so thrown/rejected errors become a 500
 * response instead of an unhandled rejection that could crash the process. */
/** Connection-level failures: the store is unreachable, not the code broken. */
function isUnreachable(err: any): boolean {
  const text = `${err?.code ?? ""} ${err?.message ?? ""} ${err?.errors?.[0]?.code ?? ""}`;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|Connection terminated|terminating connection|timeout/i.test(
    text,
  );
}

function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((err) => {
      // A database that's down is an operational condition, not a bug — log it
      // as a warning and answer with 503 so the dashboard can say "Database
      // down" instead of dying on a 500 with a stack trace behind it.
      if (isUnreachable(err)) {
        logger.warn(`${req.method} ${req.path} — store unreachable`, {
          // AggregateError (which is what ECONNREFUSED arrives as) has an
          // empty message; the useful detail is on the nested errors.
          error: err?.message || err?.errors?.[0]?.message || err?.code || String(err),
        });
        if (!res.headersSent) {
          res.status(503).json({
            error: "Store unavailable",
            detail: "The database or broker is unreachable. Retrying automatically.",
          });
        }
        return;
      }

      logger.error(`API error on ${req.method} ${req.path}`, { error: String(err), stack: err?.stack });
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    });
  };
}

/**
 * Creates the Queueway HTTP API (used by the CLI, the dashboard, and
 * anyone hitting the REST endpoints directly). Does NOT call .listen() —
 * that's left to the caller (see start() below or your own server.ts).
 */
export async function createServer(queue: Queueway): Promise<Express> {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const authStore = new AuthStore();
  await authStore.initialize();

  // Signup/login/logout/forgot-password — always public (obviously).
  registerAuthRoutes(app, authStore);

  // Dashboard — real Next.js UI, pre-built as static files, served here
  // automatically. Public shell; the app itself shows signup/login/dashboard
  // based on calling the (protected) API below.
  app.use(express.static(path.join(__dirname, "..", "..", "public")));

  // Everything under /queueway/* requires a logged-in session.
  app.use("/queueway", requireAuth(authStore));

  app.get("/queueway/health", async (_req, res) => {
    // Deliberately not wrapped: health is the one route that must always
    // answer, especially when the store is down.
    try {
      const status = await queue.getHealth();
      res.status(status.status === "healthy" ? 200 : 503).json(status);
    } catch (err: any) {
      res.status(503).json({
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        components: {
          broker: { status: "down", error: "Health check failed" },
          database: { status: "down", error: err?.message ?? String(err) },
          api: { status: "up" },
        },
      });
    }
  });

  app.get("/queueway/stats", asyncRoute(async (_req, res) => {
    res.json(await queue.getStats());
  }));

  app.get("/queueway/jobs", asyncRoute(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await queue.getJobs(status, limit));
  }));

  app.get("/queueway/jobs/:id", asyncRoute(async (req, res) => {
    const job = await queue.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(job);
  }));

  app.get("/queueway/dlq", asyncRoute(async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await queue.getDLQ(limit));
  }));

  app.post("/queueway/jobs/:id/retry", asyncRoute(async (req, res) => {
    await queue.retryJob(req.params.id);
    res.json({ ok: true, jobId: req.params.id, status: "pending" });
  }));

  app.delete("/queueway/jobs/:id", asyncRoute(async (req, res) => {
    const job = await queue.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    await queue.deleteJob(req.params.id);
    res.json({ ok: true, jobId: req.params.id, deleted: true });
  }));

  return app;
}

/** Convenience helper: build + start the server on the given port. */
export async function startServer(queue: Queueway, port = 4287) {
  const app = await createServer(queue);

  return new Promise<import("http").Server>((resolve) => {
    const server = app.listen(port, () => {
      logger.info(`✅ Queueway API listening on http://localhost:${port}`);

      // Best-effort: also show how to reach this server from elsewhere —
      // the "localhost" URL above is only useful on this exact machine,
      // which isn't helpful if this is running on a remote/cloud server.
      for (const ip of getLocalNetworkIPs()) {
        logger.info(`   Also reachable on your local network at: http://${ip}:${port}`);
      }
      getPublicIP().then((publicIP) => {
        if (publicIP) {
          logger.info(`   If this is a cloud server, your public URL is: http://${publicIP}:${port}`);
        }
      });

      resolve(server);
    });
  });
}
