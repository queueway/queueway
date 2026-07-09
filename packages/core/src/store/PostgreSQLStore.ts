import { Pool } from "pg";
import { IStore } from "./IStore";
import { Job } from "../types";
import { logger } from "../logging/Logger";

export class PostgreSQLStore implements IStore {
  private pool: Pool;

  constructor() {
    const url = process.env.DATABASE_URL || "postgres://localhost/queueway";
    this.pool = new Pool({ connectionString: url });
  }

  async initialize(): Promise<void> {
    const query = `
      CREATE TABLE IF NOT EXISTS queueway_jobs (
        id VARCHAR(255) PRIMARY KEY,
        event_name VARCHAR(255) NOT NULL,
        data JSONB NOT NULL,
        status VARCHAR(50) NOT NULL,
        attempts INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_status ON queueway_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_event ON queueway_jobs(event_name);
    `;

    await this.pool.query(query);
    logger.info("✅ PostgreSQL initialized");
  }

  async saveJob(job: Job): Promise<void> {
    const query = `
      INSERT INTO queueway_jobs (id, event_name, data, status, attempts)
      VALUES ($1, $2, $3, $4, $5)
    `;

    await this.pool.query(query, [
      job.id,
      job.eventName,
      JSON.stringify(job.data),
      job.status,
      job.attempts,
    ]);
  }

  async getJob(jobId: string): Promise<Job | null> {
    const result = await this.pool.query(
      "SELECT * FROM queueway_jobs WHERE id = $1",
      [jobId],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      eventName: row.event_name,
      data: row.data,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at,
    };
  }

  async updateJob(
    jobId: string,
    status: string,
    attempts?: number,
  ): Promise<void> {
    if (attempts !== undefined) {
      await this.pool.query(
        "UPDATE queueway_jobs SET status = $1, attempts = $2, updated_at = NOW() WHERE id = $3",
        [status, attempts, jobId],
      );
    } else {
      await this.pool.query(
        "UPDATE queueway_jobs SET status = $1, updated_at = NOW() WHERE id = $2",
        [status, jobId],
      );
    }
  }

  async getAllJobs(status?: string, limit?: number): Promise<Job[]> {
    let query = "SELECT * FROM queueway_jobs";
    const params: any[] = [];

    if (status) {
      query += " WHERE status = $1";
      params.push(status);
    }

    query += " ORDER BY created_at DESC";

    if (limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(limit);
    }

    const result = await this.pool.query(query, params);

    return result.rows.map((row: any) => ({
      id: row.id,
      eventName: row.event_name,
      data: row.data,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at,
    }));
  }

  async recoverStuckJobs(): Promise<Job[]> {
    const stuckStatuses = ["pending", "processing", "retrying"];

    const result = await this.pool.query(
      `SELECT * FROM queueway_jobs WHERE status = ANY($1::text[])`,
      [stuckStatuses],
    );

    if (result.rows.length === 0) return [];

    await this.pool.query(
      `UPDATE queueway_jobs SET status = 'pending' WHERE status = ANY($1::text[])`,
      [stuckStatuses],
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      eventName: row.event_name,
      data: row.data,
      status: "pending" as const,
      attempts: row.attempts,
      createdAt: row.created_at,
    }));
  }

  async checkHealth(): Promise<import("../types").ComponentHealth> {
    try {
      const start = Date.now();
      await this.pool.query("SELECT 1");
      return { status: "up", latency: Date.now() - start };
    } catch (err: any) {
      return { status: "down", error: err?.message ?? String(err) };
    }
  }
}
