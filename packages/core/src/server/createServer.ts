import express, { Express, Request, Response } from 'express';
import { QueueKit } from '../QueueKit';
import { HealthCheck } from '../monitoring/HealthCheck';

/**
 * Creates the QueueKit HTTP API (used by the CLI, the dashboard, and
 * anyone hitting the REST endpoints directly). Does NOT call .listen() —
 * that's left to the caller (see start() below or your own server.ts).
 */
export function createServer(queue: QueueKit): Express {
  const app = express();
  app.use(express.json());

  const health = new HealthCheck();

  app.get('/queuekit/health', async (_req: Request, res: Response) => {
    res.json(await health.getStatus());
  });

  app.get('/queuekit/stats', async (_req: Request, res: Response) => {
    res.json(await queue.getStats());
  });

  app.get('/queuekit/jobs', async (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await queue.getJobs(status, limit));
  });

  app.get('/queuekit/jobs/:id', async (req: Request, res: Response) => {
    const job = await queue.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  });

  app.get('/queuekit/dlq', async (req: Request, res: Response) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await queue.getDLQ(limit));
  });

  app.post('/queuekit/jobs/:id/retry', async (req: Request, res: Response) => {
    await queue.retryJob(req.params.id);
    res.json({ ok: true, jobId: req.params.id, status: 'pending' });
  });

  return app;
}

/** Convenience helper: build + start the server on the given port. */
export function startServer(queue: QueueKit, port = 3000) {
  const app = createServer(queue);
  return app.listen(port, () => {
    console.log(`✅ QueueKit API listening on http://localhost:${port}`);
  });
}
