import path from 'path';
import express, { Express, Request, Response } from 'express';
import { Queueway } from '../Queueway';
import { HealthCheck } from '../monitoring/HealthCheck';

/**
 * Creates the Queueway HTTP API (used by the CLI, the dashboard, and
 * anyone hitting the REST endpoints directly). Does NOT call .listen() —
 * that's left to the caller (see start() below or your own server.ts).
 */
export function createServer(queue: Queueway): Express {
  const app = express();
  app.use(express.json());

  // Basic CORE dashboard — plain HTML/JS, no build step required.
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  const health = new HealthCheck();

  app.get('/queueway/health', async (_req: Request, res: Response) => {
    res.json(await health.getStatus());
  });

  app.get('/queueway/stats', async (_req: Request, res: Response) => {
    res.json(await queue.getStats());
  });

  app.get('/queueway/jobs', async (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await queue.getJobs(status, limit));
  });

  app.get('/queueway/jobs/:id', async (req: Request, res: Response) => {
    const job = await queue.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  });

  app.get('/queueway/dlq', async (req: Request, res: Response) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await queue.getDLQ(limit));
  });

  app.post('/queueway/jobs/:id/retry', async (req: Request, res: Response) => {
    await queue.retryJob(req.params.id);
    res.json({ ok: true, jobId: req.params.id, status: 'pending' });
  });

  return app;
}

/** Convenience helper: build + start the server on the given port. */
export function startServer(queue: Queueway, port = 3000) {
  const app = createServer(queue);
  return app.listen(port, () => {
    console.log(`✅ Queueway API listening on http://localhost:${port}`);
  });
}
