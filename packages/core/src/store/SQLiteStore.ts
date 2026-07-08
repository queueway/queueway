import sqlite3 from 'sqlite3';
import { IStore } from './IStore';
import { Job } from '../types';

/**
 * File-based store using SQLite — good for local dev / single-server
 * deployments where you want persistence without running Postgres.
 */
export class SQLiteStore implements IStore {
  private db: sqlite3.Database;

  constructor(filename = process.env.SQLITE_PATH || './queueway.db') {
    this.db = new sqlite3.Database(filename);
  }

  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `CREATE TABLE IF NOT EXISTS queueway_jobs (
          id TEXT PRIMARY KEY,
          event_name TEXT NOT NULL,
          data TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER DEFAULT 0,
          created_at TEXT NOT NULL
        )`,
        (err) => {
          if (err) return reject(err);
          console.log('✅ SQLite initialized');
          resolve();
        }
      );
    });
  }

  async saveJob(job: Job): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO queueway_jobs (id, event_name, data, status, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          job.id,
          job.eventName,
          JSON.stringify(job.data),
          job.status,
          job.attempts,
          job.createdAt.toISOString(),
        ],
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  async getJob(jobId: string): Promise<Job | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM queueway_jobs WHERE id = ?`,
        [jobId],
        (err, row: any) => {
          if (err) return reject(err);
          if (!row) return resolve(null);
          resolve(this.rowToJob(row));
        }
      );
    });
  }

  async updateJob(jobId: string, status: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE queueway_jobs SET status = ? WHERE id = ?`,
        [status, jobId],
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  async getAllJobs(status?: string, limit?: number): Promise<Job[]> {
    return new Promise((resolve, reject) => {
      let query = 'SELECT * FROM queueway_jobs';
      const params: any[] = [];

      if (status) {
        query += ' WHERE status = ?';
        params.push(status);
      }

      query += ' ORDER BY created_at DESC';

      if (limit) {
        query += ' LIMIT ?';
        params.push(limit);
      }

      this.db.all(query, params, (err, rows: any[]) => {
        if (err) return reject(err);
        resolve(rows.map((row) => this.rowToJob(row)));
      });
    });
  }

  private rowToJob(row: any): Job {
    return {
      id: row.id,
      eventName: row.event_name,
      data: JSON.parse(row.data),
      status: row.status,
      attempts: row.attempts,
      createdAt: new Date(row.created_at),
    };
  }
}
